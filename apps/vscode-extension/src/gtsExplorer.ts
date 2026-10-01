import * as vscode from 'vscode'
import * as path from 'path'
import { getRegistry, getMalformedIds, getPathsWithMalformedIds } from './registryStore'
import { countPublishedProblems } from './validation'

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
  children: Map<string, GtsFileNode | GtsFolderNode>
}

type GtsTreeElement = GtsFileNode | GtsFolderNode

/**
 * Tree path segments for a file: relative to its workspace folder, under a
 * top-level node named after that folder when the workspace has several roots.
 * Files outside every folder keep their absolute path.
 */
function treePathParts(fsPath: string, multiRoot: boolean): string[] {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))
  if (!folder) return fsPath.split(path.sep).filter(Boolean)
  const rel = path.relative(folder.uri.fsPath, fsPath).split(path.sep).filter(Boolean)
  return multiRoot ? [folder.name, ...rel] : rel
}

/** Build a nested folder/file tree (per workspace folder) from a flat list of absolute paths. */
function buildFileTree(filePaths: string[]): GtsFolderNode {
  const root: GtsFolderNode = { kind: 'folder', label: '', children: new Map() }
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
  for (const fsPath of filePaths) {
    const parts = treePathParts(fsPath, multiRoot)
    let current = root
    parts.forEach((part, idx) => {
      const isLast = idx === parts.length - 1
      if (isLast) {
        current.children.set(part, { kind: 'file', label: part, fsPath })
        return
      }
      const existing = current.children.get(part)
      if (existing && existing.kind === 'folder') {
        current = existing
      } else {
        const folder: GtsFolderNode = { kind: 'folder', label: part, children: new Map() }
        current.children.set(part, folder)
        current = folder
      }
    })
  }
  return root
}

/** Folders first, then files, both alphabetically (case-insensitive). */
function sortedChildren(folder: GtsFolderNode): GtsTreeElement[] {
  return Array.from(folder.children.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
}

/**
 * Every file the registry currently knows about: parsed GTS files, files that
 * failed to parse, and files whose only GTS content is malformed ids (those
 * hold no valid entity, so the registry itself doesn't list them).
 */
function getDiscoveredFilePaths(): string[] {
  const registry = getRegistry()
  if (!registry) return []
  return Array.from(new Set<string>([
    ...registry.jsonFiles.keys(),
    ...registry.invalidFiles.keys(),
    ...getPathsWithMalformedIds()
  ]))
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
    return
  }
  for (const child of element.children.values()) collectFilePaths(child, out)
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

  private root: GtsFolderNode = { kind: 'folder', label: '', children: new Map() }
  // The set of discovered file paths currently reflected in the tree. Used to
  // avoid rebuilding (and thus visually flickering) the whole tree when only
  // file *contents* changed but the file list is the same.
  private knownPaths = new Set<string>()

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
    const paths = getDiscoveredFilePaths()
    const nextSet = new Set(paths)

    const changed: vscode.Uri[] = []
    for (const p of nextSet) if (!this.knownPaths.has(p)) changed.push(vscode.Uri.file(p))
    for (const p of this.knownPaths) if (!nextSet.has(p)) changed.push(vscode.Uri.file(p))
    if (changed.length === 0) return []

    this.knownPaths = nextSet
    this.root = buildFileTree(paths)
    this._onDidChangeTreeData.fire()
    return changed
  }

  getTreeItem(element: GtsTreeElement): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None)
      item.resourceUri = vscode.Uri.file(element.fsPath)
      item.contextValue = 'gtsFile'
      item.command = {
        command: 'gts-kit.openFileFromTree',
        title: 'Open GTS File',
        arguments: [element.fsPath]
      }
      item.tooltip = hasGtsErrors(item.resourceUri)
        ? 'Has GTS validation errors'
        : 'No GTS validation errors'
      return item
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded)
    item.iconPath = vscode.ThemeIcon.Folder
    item.contextValue = 'gtsFolder'
    return item
  }

  getChildren(element?: GtsTreeElement): GtsTreeElement[] {
    const folder = element ? (element.kind === 'folder' ? element : undefined) : this.root
    if (!folder) return []
    return sortedChildren(folder)
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
 * count, so every GTS problem looks the same everywhere.
 */
export class GtsFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

  refresh(uris?: vscode.Uri[]): void {
    this._onDidChangeFileDecorations.fire(uris)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!isDiscoveredGtsFile(uri.fsPath)) return undefined

    if (hasGtsErrors(uri)) return undefined
    return new vscode.FileDecoration(undefined, 'GTS: file is valid', new vscode.ThemeColor('charts.green'))
  }
}

export interface GtsExplorer {
  treeProvider: GtsFileTreeProvider
  decorationProvider: GtsFileDecorationProvider
  reset(): void
  /** Call after the registry's set of discovered files may have changed (rescan, index/remove file). */
  refresh(): void
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
    vscode.commands.registerCommand('gts-kit.openFileFromTree', async (fsPath: string) => {
      try {
        const uri = vscode.Uri.file(fsPath)
        await vscode.window.showTextDocument(uri, { preview: false })
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open GTS file: ${error?.message || String(error)}`)
      }
    }),
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
    new vscode.Disposable(() => { if (updateTimer) clearTimeout(updateTimer) })
  )

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
      // handler above. A global decoration refresh here would flicker every file.
      // Called on every keystroke in a GTS file, so the badge recount is debounced.
      const changed = treeProvider.refresh()
      if (changed.length > 0) decorationProvider.refresh(changed)
      scheduleTreeUpdate()
    }
  }
}
