import * as vscode from 'vscode'
import * as path from 'path'
import { getRegistry, getMalformedIds, getPathsWithMalformedIds } from './registryStore'
import { countPublishedProblems, isValidationKnown, onValidationStateChanged, onWorkspaceValidationProgress } from './validation'

/**
 * Left-sidebar file browser for GTS: shows every discovered file that holds at
 * least one GTS schema/instance (or failed to parse), colors it green/red
 * depending on whether it currently has GTS validation errors, and opens it in
 * the editor on click.
 *
 * Both the file list and the error state are read straight from the shared
 * registry (registryStore) and from VS Code's own diagnostics store — the same
 * sources the link/decoration provider and the webview viewer already use — so
 * the tree, the in-editor highlighting and the GTS Viewer diagrams always agree.
 */

interface GtsFileNode {
  kind: 'file'
  label: string
  fsPath: string
}

interface GtsFolderNode {
  kind: 'folder'
  label: string
  /** The folder's absolute path ('' for the invisible root). */
  fsPath: string
  children: Map<string, GtsFileNode | GtsFolderNode>
  /** Children in display order, computed on first request. */
  sorted?: GtsTreeElement[]
}

/** The first row while a scan or validation runs, showing its status. */
interface GtsStatusNode {
  kind: 'status'
  text: string
}

export type GtsTreeElement = GtsFileNode | GtsFolderNode | GtsStatusNode

/** A folder rescan's progress: waiting behind other scans, or a phase's percentage. */
export type FolderProgress = 'queued' | { phase: 'scanning' | 'validating'; percent: number }

// Repainting a folder row makes VS Code fetch the folder's whole (expanded)
// subtree again, and shows a second spinner in place of its twistie while
// that is slow, so a row's percentage is repainted at most this often (a
// phase change always repaints).
const FOLDER_PROGRESS_REPAINT_MS = 1000

function folderProgressText(progress: FolderProgress): string {
  if (progress === 'queued') return 'waiting…'
  return `${progress.phase} ${Math.max(0, Math.min(100, Math.floor(progress.percent)))}%`
}

/** `dir` + `name` with exactly one separator between them ('' for no parent). */
function joinFsPath(dir: string, name: string): string {
  if (!dir) return name
  return dir.endsWith(path.sep) ? dir + name : dir + path.sep + name
}

/** Child folder `label` of `parent`, created if missing. */
function getChildFolder(parent: GtsFolderNode, label: string, fsPath: string): GtsFolderNode {
  const existing = parent.children.get(label)
  if (existing?.kind === 'folder') return existing
  const folder: GtsFolderNode = { kind: 'folder', label, fsPath, children: new Map() }
  parent.children.set(label, folder)
  return folder
}

/**
 * Build a nested folder/file tree from a flat list of absolute paths. Paths
 * are shown relative to their workspace folder, under a top-level node named
 * after that folder when the workspace has several roots. Files outside every
 * folder keep their absolute path.
 */
function buildFileTree(filePaths: Iterable<string>, folders: Map<string, GtsFolderNode>): GtsFolderNode {
  const root: GtsFolderNode = { kind: 'folder', label: '', fsPath: '', children: new Map() }
  const childFolder = (parent: GtsFolderNode, label: string, fsPath: string) => {
    const folder = getChildFolder(parent, label, fsPath)
    folders.set(fsPath, folder)
    return folder
  }
  // Innermost first, so a file in nested workspace folders goes to the nested
  // one (as with getWorkspaceFolder, which was too slow to call per file).
  const workspaceFolders = (vscode.workspace.workspaceFolders || [])
    .map(f => ({ name: f.name, fsPath: f.uri.fsPath, prefix: joinFsPath(f.uri.fsPath, '') }))
    .sort((a, b) => b.fsPath.length - a.fsPath.length)
  const multiRoot = workspaceFolders.length > 1
  for (const fsPath of filePaths) {
    const workspaceFolder = workspaceFolders.find(f => fsPath.startsWith(f.prefix))
    let current = root
    let dir: string
    let parts: string[]
    if (workspaceFolder) {
      if (multiRoot) current = childFolder(root, workspaceFolder.name, workspaceFolder.fsPath)
      dir = workspaceFolder.fsPath
      parts = fsPath.slice(workspaceFolder.prefix.length).split(path.sep).filter(Boolean)
    } else {
      dir = fsPath.startsWith(path.sep) ? path.sep : ''
      parts = fsPath.split(path.sep).filter(Boolean)
    }
    for (let i = 0; i < parts.length - 1; i++) {
      dir = joinFsPath(dir, parts[i])
      current = childFolder(current, parts[i], dir)
    }
    const name = parts[parts.length - 1]
    if (name) current.children.set(name, { kind: 'file', label: name, fsPath })
  }
  return root
}

// One shared collator: `localeCompare` with options builds a collator per
// call, which made sorting a folder of 100K files take seconds.
const labelCollator = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Folders first, then files, both alphabetically (case-insensitive). */
function sortedChildren(folder: GtsFolderNode): GtsTreeElement[] {
  folder.sorted ??= Array.from(folder.children.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return labelCollator.compare(a.label, b.label)
  })
  return folder.sorted
}

/**
 * Every file the registry currently knows about: parsed GTS files, files that
 * failed to parse, and files whose only GTS content is malformed ids (those
 * hold no valid entity, so the registry itself doesn't list them).
 */
function getDiscoveredFilePaths(): Set<string> {
  const paths = new Set<string>()
  const registry = getRegistry()
  if (!registry) return paths
  for (const p of registry.jsonFiles.keys()) paths.add(p)
  for (const p of registry.invalidFiles.keys()) paths.add(p)
  for (const p of getPathsWithMalformedIds()) paths.add(p)
  return paths
}

function isDiscoveredGtsFile(fsPath: string): boolean {
  const registry = getRegistry()
  if (!registry) return false
  return registry.jsonFiles.has(fsPath) || registry.invalidFiles.has(fsPath) || getMalformedIds(fsPath).length > 0
}

function gtsDiagnosticsOf(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter(d => d.source === 'GTS')
}

/** True if the given file currently has a GTS validation error. */
export function hasGtsErrors(uri: vscode.Uri): boolean {
  if (gtsDiagnosticsOf(uri).length > 0) return true
  const registry = getRegistry()
  if (!registry) return false
  const fsPath = uri.fsPath
  if (registry.invalidFiles.get(fsPath)?.validation?.errors.length) return true
  if (getMalformedIds(fsPath).length > 0) return true
  const entities = [...(registry.jsonFileSchemas.get(fsPath) || []), ...(registry.jsonFileObjs.get(fsPath) || [])]
  return entities.some(entity => Boolean(entity.validation?.errors.length))
}

/** Collect every file path under an element (a single file, or all files under a folder subtree). */
function collectFilePaths(element: GtsTreeElement, out: string[]): void {
  if (element.kind === 'file') {
    out.push(element.fsPath)
  } else if (element.kind === 'folder') {
    for (const child of element.children.values()) collectFilePaths(child, out)
  }
}

export class GtsFileTreeProvider
  implements vscode.TreeDataProvider<GtsTreeElement>, vscode.TreeDragAndDropController<GtsTreeElement>
{
  // Advertise `text/uri-list` so dragged items are understood by the editor,
  // the Explorer and the chat as regular file references. We don't accept drops.
  readonly dragMimeTypes = ['text/uri-list']
  readonly dropMimeTypes: string[] = []

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<GtsTreeElement | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private root: GtsFolderNode = { kind: 'folder', label: '', fsPath: '', children: new Map() }
  // The set of discovered file paths currently reflected in the tree. Used to
  // avoid rebuilding (and thus visually flickering) the whole tree when only
  // file *contents* changed but the file list is the same.
  private knownPaths = new Set<string>()
  // Folder nodes of the current tree by path, to repaint a single folder row.
  private folders = new Map<string, GtsFolderNode>()
  // Progress text shown on the rows of folders being rescanned, and when each
  // row was last repainted.
  private readonly folderProgress = new Map<string, string>()
  private readonly folderRepaints = new Map<string, { at: number; timer?: NodeJS.Timeout }>()
  private status: GtsStatusNode | undefined

  /**
   * Show `text` (dimmed) as the first row, e.g. scan or validation progress,
   * or remove the row with `undefined`. VS Code's view message can't be
   * styled, and the title description isn't shown for a view that is alone in
   * its container.
   */
  setStatus(text: string | undefined): void {
    if (!text) {
      if (!this.status) return
      this.status = undefined
      this._onDidChangeTreeData.fire()
    } else if (!this.status) {
      this.status = { kind: 'status', text }
      this._onDidChangeTreeData.fire()
    } else if (this.status.text !== text) {
      // Only this (leaf) row is repainted.
      this.status.text = text
      this._onDidChangeTreeData.fire(this.status)
    }
  }

  /**
   * Show `progress` on the row of the folder at `fsPath` while it is being
   * rescanned (in place of its Rescan button), or clear it with `undefined`.
   */
  setFolderProgress(fsPath: string, progress: FolderProgress | undefined): void {
    const previous = this.folderProgress.get(fsPath)
    const text = progress === undefined ? undefined : folderProgressText(progress)
    if (text === previous) return
    if (text === undefined) this.folderProgress.delete(fsPath)
    else this.folderProgress.set(fsPath, text)

    const repaint = this.folderRepaints.get(fsPath) ?? { at: 0 }
    this.folderRepaints.set(fsPath, repaint)
    if (repaint.timer) clearTimeout(repaint.timer)
    repaint.timer = undefined
    const samePhase = previous !== undefined && text !== undefined && previous.split(' ')[0] === text.split(' ')[0]
    const wait = samePhase ? repaint.at + FOLDER_PROGRESS_REPAINT_MS - Date.now() : 0
    const fire = () => {
      repaint.timer = undefined
      repaint.at = Date.now()
      if (text === undefined) this.folderRepaints.delete(fsPath)
      const folder = this.folders.get(fsPath)
      if (folder) this._onDidChangeTreeData.fire(folder)
    }
    if (wait > 0) repaint.timer = setTimeout(fire, wait)
    else fire()
  }

  /**
   * Reconcile the tree with the current registry state. Only rebuilds (and fires
   * a tree-data change) when the *set* of discovered files actually changed —
   * green/red error state is handled separately via file decorations, so a plain
   * content edit must not rebuild the tree. Returns the URIs that were added or
   * removed so the caller can refresh just those decorations.
   */
  /** True if the tree currently lists this file. */
  lists(fsPath: string): boolean {
    return this.knownPaths.has(fsPath)
  }

  refresh(): vscode.Uri[] {
    const nextSet = getDiscoveredFilePaths()

    const changed: vscode.Uri[] = []
    for (const p of nextSet) if (!this.knownPaths.has(p)) changed.push(vscode.Uri.file(p))
    for (const p of this.knownPaths) if (!nextSet.has(p)) changed.push(vscode.Uri.file(p))
    if (changed.length === 0) return []

    this.knownPaths = nextSet
    this.folders = new Map()
    this.root = buildFileTree(nextSet, this.folders)
    this._onDidChangeTreeData.fire()
    return changed
  }

  getTreeItem(element: GtsTreeElement): vscode.TreeItem {
    if (element.kind === 'status') {
      // The text goes in the description, which VS Code renders dimmed.
      const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None)
      item.description = element.text
      item.tooltip = element.text
      item.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('descriptionForeground'))
      item.contextValue = 'gtsStatus'
      return item
    }
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None)
      item.resourceUri = vscode.Uri.file(element.fsPath)
      item.contextValue = 'gtsFile'
      // The built-in `vscode.open` is converted to a workbench command when the
      // item is sent to the UI, so a click opens the file directly instead of
      // round-tripping through this extension host, which may be busy scanning
      // or validating a large workspace.
      item.command = {
        command: 'vscode.open',
        title: 'Open GTS File',
        arguments: [item.resourceUri, { preview: false }]
      }
      // The tooltip is filled in on hover (resolveTreeItem), so it reflects the
      // file's validation state at that moment rather than when the row was built.
      return item
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded)
    item.tooltip = element.fsPath
    const progress = this.folderProgress.get(element.fsPath)
    if (progress === undefined) {
      item.iconPath = vscode.ThemeIcon.Folder
      item.contextValue = 'gtsFolder'
    } else {
      // A different context value hides the Rescan button while it runs.
      item.iconPath = new vscode.ThemeIcon('loading~spin')
      item.contextValue = 'gtsFolderRescanning'
      item.description = progress
    }
    return item
  }

  resolveTreeItem(item: vscode.TreeItem, element: GtsTreeElement): vscode.TreeItem {
    if (element.kind === 'file') {
      const uri = vscode.Uri.file(element.fsPath)
      item.tooltip = !isValidationKnown(element.fsPath)
        ? 'GTS validation pending'
        : hasGtsErrors(uri) ? 'Has GTS validation errors' : 'No GTS validation errors'
    }
    return item
  }

  getChildren(element?: GtsTreeElement): GtsTreeElement[] {
    if (!element) return this.status ? [this.status, ...sortedChildren(this.root)] : sortedChildren(this.root)
    return element.kind === 'folder' ? sortedChildren(element) : []
  }

  /**
   * Expose dragged files (and every file under a dragged folder) as a
   * `text/uri-list` payload — a newline-separated list of file URIs — which the
   * editor and chat accept as file references, so items can be dropped there.
   */
  handleDrag(
    source: readonly GtsTreeElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    const fsPaths: string[] = []
    for (const element of source) collectFilePaths(element, fsPaths)
    if (fsPaths.length === 0) return
    const uriList = fsPaths.map(p => vscode.Uri.file(p).toString()).join('\r\n')
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriList))
  }
}

/**
 * Colors every valid GTS file green (in the sidebar tree, the OS-style Explorer
 * and editor tabs). Files with GTS problems get no decoration of their own:
 * VS Code's Problems decoration colors them with its standard error color and
 * count, so every GTS problem looks the same everywhere. Files that haven't
 * been validated yet stay uncolored: no diagnostics doesn't mean valid yet.
 */
export class GtsFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

  refresh(uris?: vscode.Uri[]): void {
    // VS Code eagerly re-fetches the decoration of every URI listed in a change
    // event, one provider call per file, while a flush (`undefined`) only
    // re-fetches what is on screen. Past a few thousand files (a scan, a
    // validation batch) the flush is far cheaper, at the cost of a repaint.
    this._onDidChangeFileDecorations.fire(uris && uris.length <= MAX_DECORATION_CHANGE_URIS ? uris : undefined)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!isDiscoveredGtsFile(uri.fsPath)) return undefined
    if (!isValidationKnown(uri.fsPath)) return undefined

    if (hasGtsErrors(uri)) return undefined
    return new vscode.FileDecoration(undefined, 'GTS: file is valid', new vscode.ThemeColor('charts.green'))
  }
}

const MAX_DECORATION_CHANGE_URIS = 2000

export interface GtsExplorer {
  treeProvider: GtsFileTreeProvider
  decorationProvider: GtsFileDecorationProvider
  reset(): void
  /** Call after the registry's set of discovered files may have changed (rescan, index/remove file). Debounced. */
  refresh(): void
  /** Status of the running scan, shown dimmed as the tree's first row (undefined: none). */
  setScanStatus(status: string | undefined): void
  /** Progress of a folder rescan, shown on the folder's row (undefined: done). */
  setFolderProgress(fsPath: string, progress: FolderProgress | undefined): void
}

/** Update the small rounded problem-count badge shown next to the view title. */
function updateBadge(treeView: vscode.TreeView<GtsTreeElement>): void {
  const count = countPublishedProblems()
  treeView.badge = count > 0
    ? { value: count, tooltip: `${count} GTS problem${count === 1 ? '' : 's'}` }
    : undefined
}

function registerNativeFileCommand(command: string, nativeCommand: string): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (element: GtsTreeElement) => {
    if (element?.kind !== 'file') return
    await vscode.commands.executeCommand(nativeCommand, vscode.Uri.file(element.fsPath))
  })
}

/** Wires up the tree view + file decorations and returns handles for the extension to drive refreshes with. */
export function registerGtsExplorer(context: vscode.ExtensionContext): GtsExplorer {
  const treeProvider = new GtsFileTreeProvider()
  const decorationProvider = new GtsFileDecorationProvider()

  const treeView = vscode.window.createTreeView('gts-kit.fileExplorer', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
    showCollapseAll: true
  })

  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    registerNativeFileCommand('gts-kit.openToSide', 'explorer.openToSide'),
    registerNativeFileCommand('gts-kit.openWith', 'explorer.openWith'),
    registerNativeFileCommand('gts-kit.revealInFinder', 'revealFileInOS'),
    registerNativeFileCommand('gts-kit.revealInFileExplorer', 'revealFileInOS'),
    registerNativeFileCommand('gts-kit.openContainingFolder', 'revealFileInOS'),
    registerNativeFileCommand('gts-kit.openInIntegratedTerminal', 'openInIntegratedTerminal'),
    registerNativeFileCommand('gts-kit.selectForCompare', 'selectForCompare'),
    registerNativeFileCommand('gts-kit.compareWithSelected', 'compareFiles'),
    registerNativeFileCommand('gts-kit.openTimeline', 'files.openTimeline'),
    registerNativeFileCommand('gts-kit.copyPath', 'copyFilePath'),
    registerNativeFileCommand('gts-kit.copyRelativePath', 'copyRelativeFilePath'),
    // Diagnostics (and therefore per-file error state and the problem-count
    // badge) change independently of the file list. This event fires for every
    // diagnostics change of every extension (e.g. the TypeScript server on each
    // keystroke), so only GTS files are repainted, and the tree/badge work is
    // debounced.
    vscode.languages.onDidChangeDiagnostics(event => {
      const relevant = event.uris.filter(uri =>
        uri.scheme === 'file' && (isDiscoveredGtsFile(uri.fsPath) || treeProvider.lists(uri.fsPath)))
      if (relevant.length === 0) return
      decorationProvider.refresh(relevant)
      scheduleTreeUpdate()
    }),
    // A file whose validation just became known turns green without any
    // diagnostics change, so it has to be repainted explicitly.
    onValidationStateChanged(uris => {
      decorationProvider.refresh(uris)
    }),
    // Workspace validation runs after a scan (minutes on a very large
    // workspace): show its progress like the scan's.
    onWorkspaceValidationProgress(progress => {
      if (!progress) {
        validationStatus = undefined
        endValidationProgress?.()
        endValidationProgress = null
      } else {
        validationStatus = `Validating ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
        if (!endValidationProgress) {
          const ended = new Promise<void>(resolve => { endValidationProgress = resolve })
          void vscode.window.withProgress({ location: { viewId: 'gts-kit.fileExplorer' } }, () => ended)
        }
      }
      updateMessage()
    }),
    new vscode.Disposable(() => {
      if (updateTimer) clearTimeout(updateTimer)
      endValidationProgress?.()
    })
  )

  // What is running (a scan, else validation) is shown as a dimmed first row
  // of the tree (see GtsFileTreeProvider.setStatus).
  let scanStatus: string | undefined
  let validationStatus: string | undefined
  let endValidationProgress: (() => void) | null = null
  function updateMessage(): void {
    treeProvider.setStatus(scanStatus ?? validationStatus)
  }

  // Coalesces tree reconciliation + badge recount across bursts of changes.
  let updateTimer: NodeJS.Timeout | null = null
  function scheduleTreeUpdate(): void {
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = null
      const changed = treeProvider.refresh()
      if (changed.length > 0) decorationProvider.refresh(changed)
      updateBadge(treeView)
    }, 150)
  }

  treeProvider.refresh()
  decorationProvider.refresh()
  updateBadge(treeView)

  return {
    treeProvider,
    decorationProvider,
    reset() {
      treeProvider.refresh()
      decorationProvider.refresh()
      updateBadge(treeView)
    },
    refresh() {
      // Only the added/removed files need a decoration repaint; error-state
      // changes on existing files are repainted by the onDidChangeDiagnostics
      // handler above. Called on every keystroke in a GTS file and for every
      // file of an on-disk burst (git checkout), and each reconciliation walks
      // every discovered file, so it is debounced.
      scheduleTreeUpdate()
    },
    setScanStatus(status) {
      scanStatus = status
      updateMessage()
    },
    setFolderProgress(fsPath, progress) {
      treeProvider.setFolderProgress(fsPath, progress)
    }
  }
}
