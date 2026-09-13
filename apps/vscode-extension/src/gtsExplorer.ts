import * as vscode from 'vscode'
import * as path from 'path'
import { getRegistry } from './registryStore'

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

/** Build a nested folder/file tree (relative to the workspace root) from a flat list of absolute paths. */
function buildFileTree(filePaths: string[], workspaceRoot: string): GtsFolderNode {
  const root: GtsFolderNode = { kind: 'folder', label: '', children: new Map() }
  for (const fsPath of filePaths) {
    const rel = workspaceRoot ? path.relative(workspaceRoot, fsPath) : fsPath
    const parts = rel.split(path.sep).filter(Boolean)
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

/** Every file path the registry currently knows about (parsed GTS files + files that failed to parse). */
function getDiscoveredFilePaths(): string[] {
  const registry = getRegistry()
  if (!registry) return []
  const paths = new Set<string>([...registry.jsonFiles.keys(), ...registry.invalidFiles.keys()])
  return Array.from(paths)
}

/** True if the given file currently has a GTS validation error reported on it. */
export function hasGtsErrors(uri: vscode.Uri): boolean {
  return vscode.languages.getDiagnostics(uri).some(d => d.source === 'GTS')
}

/** Total number of GTS validation problems currently reported across the workspace. */
function countGtsProblems(): number {
  let count = 0
  for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const d of diagnostics) {
      if (d.source === 'GTS') count++
    }
  }
  return count
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
  refresh(): vscode.Uri[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    const paths = getDiscoveredFilePaths()
    const nextSet = new Set(paths)

    const changed: vscode.Uri[] = []
    for (const p of nextSet) if (!this.knownPaths.has(p)) changed.push(vscode.Uri.file(p))
    for (const p of this.knownPaths) if (!nextSet.has(p)) changed.push(vscode.Uri.file(p))
    if (changed.length === 0) return []

    this.knownPaths = nextSet
    this.root = buildFileTree(paths, workspaceRoot)
    this._onDidChangeTreeData.fire()
    return changed
  }

  getTreeItem(element: GtsTreeElement): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None)
      item.resourceUri = vscode.Uri.file(element.fsPath)
      item.contextValue = 'gtsFile'
      item.command = {
        command: 'gts.openFileFromTree',
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
 * Colors every GTS file (in the sidebar tree, the OS-style Explorer, and open
 * editor tabs) light green when it has no GTS errors and light red when it
 * does. Driven by the same registry + diagnostics the rest of the extension
 * uses, so the color always matches the squiggles in the open document.
 */
export class GtsFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

  refresh(uris?: vscode.Uri[]): void {
    this._onDidChangeFileDecorations.fire(uris)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const registry = getRegistry()
    if (!registry) return undefined
    const fsPath = uri.fsPath
    const isDiscoveredGtsFile = registry.jsonFiles.has(fsPath) || registry.invalidFiles.has(fsPath)
    if (!isDiscoveredGtsFile) return undefined

    if (hasGtsErrors(uri)) {
      return new vscode.FileDecoration('!', 'GTS: file has validation errors', new vscode.ThemeColor('charts.red'))
    }
    return new vscode.FileDecoration(undefined, 'GTS: file is valid', new vscode.ThemeColor('charts.green'))
  }
}

export interface GtsExplorer {
  treeProvider: GtsFileTreeProvider
  decorationProvider: GtsFileDecorationProvider
  /** Call after the registry's set of discovered files may have changed (rescan, index/remove file). */
  refresh(): void
}

/** Update the small rounded problem-count badge shown next to the view title. */
function updateBadge(treeView: vscode.TreeView<GtsTreeElement>): void {
  const count = countGtsProblems()
  treeView.badge = count > 0
    ? { value: count, tooltip: `${count} GTS problem${count === 1 ? '' : 's'}` }
    : undefined
  console.log(`[GTS Explorer] badge updated: ${count} problem(s)`)
}

/** Wires up the tree view + file decorations and returns handles for the extension to drive refreshes with. */
export function registerGtsExplorer(context: vscode.ExtensionContext): GtsExplorer {
  const treeProvider = new GtsFileTreeProvider()
  const decorationProvider = new GtsFileDecorationProvider()

  const treeView = vscode.window.createTreeView('gts.fileExplorer', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    showCollapseAll: true
  })

  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.commands.registerCommand('gts.openFileFromTree', async (fsPath: string) => {
      try {
        const uri = vscode.Uri.file(fsPath)
        await vscode.window.showTextDocument(uri, { preview: false })
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open GTS file: ${error?.message || String(error)}`)
      }
    }),
    // Diagnostics (and therefore per-file error state and the problem-count
    // badge) change independently of the file list — repaint whenever a URI's
    // diagnostics changed.
    vscode.languages.onDidChangeDiagnostics(event => {
      decorationProvider.refresh(event.uris as vscode.Uri[])
      updateBadge(treeView)
    })
  )

  updateBadge(treeView)

  return {
    treeProvider,
    decorationProvider,
    refresh() {
      // Only the added/removed files need a decoration repaint; error-state
      // changes on existing files are repainted by the onDidChangeDiagnostics
      // handler above. A global decoration refresh here would flicker every file.
      const changed = treeProvider.refresh()
      if (changed.length > 0) decorationProvider.refresh(changed)
      updateBadge(treeView)
    }
  }
}
