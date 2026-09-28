import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { parseGtsFileContent, DEFAULT_GTS_CONFIG } from '@gts/shared'
import type { EntityValidationDto, ObjValidationDto, InvalidFileValidationDto, ValidationRelayPayload } from '@gts/shared'
import { setLastScanFiles } from './scanStore'
import { rebuildRegistry, indexFile as indexFileInRegistry, removeFile as removeFileFromRegistry, getRegistry } from './registryStore'
import { getWorkspaceIgnore, resetWorkspaceIgnore, isGitIgnored, type FolderIgnore } from './gitignore'
import { WorkspaceLayoutStorage } from './storage'
import { initValidation, resetValidationDiagnostics, validateOpenDocument, validateWorkspaceInBackground, revalidateDependents, onValidationCompleted } from './validation'
import { isGtsCandidateFile } from './helpers'
import { GtsLinkProvider } from './linkProvider'
import { registerGtsExplorer, type GtsExplorer } from './gtsExplorer'
import type { LayoutSaveRequest, LayoutTarget, LayoutSnapshot } from '@gts/layout-storage'

// Glob used for all GTS workspace scans and the on-disk file watcher.
const GTS_SCAN_GLOB = '**/*.{json,jsonc,gts,yaml,yml}'

// Directories that are never indexed by ANY code path: full scans, file
// watchers, folder handling and re-syncs all use this one list. Everything else
// is governed by .gitignore alone, so every path agrees on what belongs in the
// index. (Build-output/dependency directories below are only *deferred* to the
// second scan phase, not excluded: they are indexed unless gitignored.)
const ALWAYS_EXCLUDED_DIRS = ['.git', '.gts-viewer']
const ALWAYS_EXCLUDE_GLOB = `**/{${ALWAYS_EXCLUDED_DIRS.join(',')}}/**`
const ALWAYS_EXCLUDED_RE = dirSegmentRegExp(ALWAYS_EXCLUDED_DIRS)

// Build-output / dependency directories. Their (often enormous) trees aren't
// even enumerated on the fast, latency-sensitive first pass; the second
// (background) pass indexes whatever in them isn't gitignored.
const PHASE2_DIRS = ['node_modules', 'target', 'build', 'out', 'dist', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor', 'bin', 'obj', '__pycache__']
const FAST_EXCLUDE_GLOB = `**/{${[...ALWAYS_EXCLUDED_DIRS, ...PHASE2_DIRS].join(',')}}/**`
const PHASE2_DIR_RE = dirSegmentRegExp(PHASE2_DIRS, 'i')

// Phase 1 enumerates at most this many files per workspace folder to bound its
// latency. Nothing beyond the cap is lost: phase 2 enumerates without a cap and
// indexes whatever phase 1 didn't.
const PHASE1_FILE_CAP = 40000

/** Regex matching a path that has one of `dirs` as a directory segment. */
function dirSegmentRegExp(dirs: string[], flags = ''): RegExp {
  const names = dirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(^|[\\\\/])(${names})([\\\\/]|$)`, flags)
}

// Framework/runtime files that are valid JSON but essentially never hold GTS
// entities. Deferred to the second pass so they don't slow the first one.
const PHASE2_FILENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'tsconfig.json', 'jsconfig.json', 'openapi.json', 'swagger.json',
  'composer.json', 'composer.lock', 'manifest.json', 'angular.json',
  'nx.json', 'lerna.json', 'turbo.json', '.eslintrc.json', '.prettierrc.json',
])

/** True if a path should be deferred to the second scan pass. */
function isDeferredToPhase2(fsPath: string): boolean {
  if (PHASE2_DIR_RE.test(fsPath)) return true
  const base = (fsPath.split(/[\\/]/).pop() || '').toLowerCase()
  if (PHASE2_FILENAMES.has(base)) return true
  // tsconfig.*.json, tsconfig.main.json, etc.
  if (/^tsconfig\..+\.json$/.test(base)) return true
  return false
}

/** Merge a base exclude glob with extra globs (e.g. from .gitignore) into one. */
function combineExcludeGlobs(base: string, extra: string[]): string {
  if (extra.length === 0) return base
  return `{${base},${extra.join(',')}}`
}

/** True if the path lies inside an always-excluded directory (see ALWAYS_EXCLUDED_DIRS). */
function isAlwaysExcluded(fsPath: string): boolean {
  return ALWAYS_EXCLUDED_RE.test(fsPath)
}

/** True if the file must never be indexed: always-excluded dir, or gitignored. */
function isExcludedFile(uri: vscode.Uri, ignores?: Map<string, FolderIgnore>): boolean {
  return isAlwaysExcluded(uri.fsPath) || isGitIgnored(uri, false, ignores)
}

/** Folder counterpart of isExcludedFile. */
function isExcludedFolder(uri: vscode.Uri): boolean {
  return isAlwaysExcluded(uri.fsPath) || isGitIgnored(uri, true)
}

/**
 * Enumerate GTS-candidate files in every workspace folder. Each folder is
 * searched separately with its own .gitignore-derived excludes, so one folder's
 * rules never hide paths in another (exclude globs are matched relative to the
 * folder). No cap unless `capPerFolder` is given; hitting it is logged.
 */
async function findGtsFiles(ignores: Map<string, FolderIgnore>, baseExclude: string, capPerFolder?: number): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = []
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const exclude = combineExcludeGlobs(baseExclude, ignores.get(folder.uri.fsPath)?.excludeGlobs || [])
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, GTS_SCAN_GLOB), exclude, capPerFolder)
    if (capPerFolder !== undefined && found.length >= capPerFolder) {
      console.warn(`[GTS] Phase 1 hit its ${capPerFolder}-file cap in "${folder.name}"; the rest is indexed by phase 2`)
    }
    uris.push(...found)
  }
  return uris
}

// Maps a file's resolved *real* path -> the workspace path we index it under.
// The workspace symlinks (e.g. .gts-spec, .gts-spec-ext, .gears-rust/.gts-spec)
// can make the same physical file reachable via several paths; without this the
// same GTS entity would be scanned multiple times, producing duplicate tree rows
// and a nondeterministic id->file mapping. We index each physical file exactly
// once and let the most-recently-scanned/edited path win (so an open file, which
// is scanned first, stays canonical and gets its in-editor diagnostics).
const realPathIndex = new Map<string, string>()

/** Resolve a path to its canonical real path; fall back to the input on error. */
function resolveRealPath(fsPath: string): string {
  try { return fs.realpathSync.native(fsPath) } catch { return fsPath }
}

/** Drop any canonical-path entries that point at `fsPath` (on delete/rename). */
function forgetIndexedPath(fsPath: string): void {
  for (const [real, p] of realPathIndex) {
    if (p === fsPath) realPathIndex.delete(real)
  }
}

/**
 * Keep only one URI per physical file, recording the canonical path chosen.
 * First-seen wins, so callers should pass higher-priority paths (open files)
 * first. Duplicates reached through other symlinks are dropped.
 */
function dedupeUrisByRealPath(uris: vscode.Uri[]): vscode.Uri[] {
  const out: vscode.Uri[] = []
  for (const uri of uris) {
    const real = resolveRealPath(uri.fsPath)
    if (realPathIndex.has(real)) continue
    realPathIndex.set(real, uri.fsPath)
    out.push(uri)
  }
  return out
}

/**
 * Index a single file's live change, ensuring the physical file stays indexed
 * under exactly one path. If another symlinked path currently owns this real
 * file, drop it so the just-touched path becomes canonical (its diagnostics show
 * in the editor). Returns nothing; callers still index the content themselves.
 */
function claimCanonicalPath(fsPath: string): void {
  const real = resolveRealPath(fsPath)
  const existing = realPathIndex.get(real)
  if (existing && existing !== fsPath) {
    removeFileFromRegistry(existing)
    forgetIndexedPath(existing)
  }
  realPathIndex.set(real, fsPath)
}

let viewerPanel: vscode.WebviewPanel | null = null
let layoutStorage: WorkspaceLayoutStorage | null = null
let hasPerformedInitialScan: boolean = false // Track if initial scan with default file has been done
let gtsLinkProvider: GtsLinkProvider | null = null
// File the user explicitly requested (context menu / command palette) — consumed by the first scanAndPost
let pendingOpenFile: string | null = null
// Left-sidebar GTS file browser (tree view + red/green file decorations), shares the same registry as everything else.
let gtsExplorer: GtsExplorer | null = null
let fullScanQueue: Promise<void> = Promise.resolve()

/** Run full scans one at a time, in request order. */
function enqueueScan(operation: () => Promise<void>): Promise<void> {
  const run = fullScanQueue.then(operation, operation)
  fullScanQueue = run.catch(() => {})
  return run
}

// Paths changed by live events (editor edits, on-disk changes, renames, closes)
// while a full scan is in flight. The scan's snapshot may predate those events,
// so instead of discarding the whole scan and starting over (which never
// converges in a busy workspace), they are re-synced from their current source
// right after the scan commits. null when no scan is running.
let pathsTouchedDuringScan: Set<string> | null = null

/** True if the text can hold a GTS id ("gts." canonical or "gts://" URI form). */
function mayContainGts(text: string): boolean {
  return text.includes('gts.') || text.includes('gts://')
}

/** Parse + index one file's text under `fsPath`, as the canonical path for its physical file. */
function indexFileText(fsPath: string, text: string): void {
  const name = path.basename(fsPath)
  let content: any
  try { content = parseGtsFileContent(name, text) } catch { content = text }
  claimCanonicalPath(fsPath)
  indexFileInRegistry(fsPath, name, content)
}

/** Drop a file's entities from the registry and the symlink-dedup index. */
function dropFileFromRegistry(fsPath: string): void {
  removeFileFromRegistry(fsPath)
  forgetIndexedPath(fsPath)
}

/**
 * Bring one file's registry entry in line with its current source of truth: the
 * live buffer if it's open, otherwise the file on disk — or drop it if it's
 * gone, ignored, or no longer mentions GTS.
 */
async function resyncFile(fsPath: string): Promise<void> {
  const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath && isGtsCandidateFile(d))
  if (openDoc) {
    indexFileText(fsPath, openDoc.getText())
    return
  }
  const uri = vscode.Uri.file(fsPath)
  if (!isGtsScanPath(fsPath) || isExcludedFile(uri) || !fs.existsSync(fsPath)) {
    dropFileFromRegistry(fsPath)
    return
  }
  const revision = fileMutationRevisions.get(fsPath)
  let text: string
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
  } catch {
    dropFileFromRegistry(fsPath)
    return
  }
  // A live handler indexed a newer version while we were reading; it wins.
  if (fileMutationRevisions.get(fsPath) !== revision) return
  if (mayContainGts(text)) indexFileText(fsPath, text)
  else dropFileFromRegistry(fsPath)
}

/**
 * Re-apply every path touched since tracking (re)started on top of the freshly
 * committed registry. With `keepTracking`, recording continues afterwards (used
 * between the two scan phases). Returns how many paths were re-synced.
 */
async function resyncPathsTouchedDuringScan(keepTracking: boolean): Promise<number> {
  const touched = pathsTouchedDuringScan
  pathsTouchedDuringScan = keepTracking ? new Set() : null
  if (!touched || touched.size === 0) return 0
  console.log(`[GTS] Re-syncing ${touched.size} file(s) changed during the scan`)
  for (const fsPath of touched) await resyncFile(fsPath)
  return touched.size
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

/**
 * Push the shared registry to the GTS Viewer webview. With `fullRescan` the
 * workspace is first rescanned from disk (from an emptied store). Either way the
 * viewer is fed from the same registry as the file tree, decorations and
 * diagnostics, so they always show the same file set. (The viewer used to run
 * its own fast-pass-only scan and then *replace* the shared registry with it,
 * dropping every phase-2 file from the tree on each edit while it was open.)
 */
async function scanAndPost(refreshFilePath?: string | null, fullRescan: boolean = false): Promise<void> {
  if (fullRescan) await performInitialScan(true)
  // Queued behind any scan in flight, so the viewer never gets a partial registry.
  await enqueueScan(() => postRegistryToViewer(refreshFilePath))
}

async function postRegistryToViewer(refreshFilePath: string | null | undefined): Promise<void> {
  const panel = viewerPanel
  if (!panel) return

  try {
    let selectedFilePath: string | null = null
    // Prefer the file the user explicitly requested via context menu / command palette
    if (pendingOpenFile) {
      selectedFilePath = pendingOpenFile
      pendingOpenFile = null
    } else {
      const activeDoc = vscode.window.activeTextEditor?.document
      selectedFilePath = (activeDoc && isGtsCandidateFile(activeDoc))
        ? activeDoc.uri.fsPath
        : null
    }

    const registry = getRegistry()
    // Every indexed file: files holding GTS entities, plus files that failed to
    // parse (their JsonFile keeps the raw text as content).
    const files: Array<{ path: string; name: string; content: any }> = registry
      ? [...registry.jsonFiles.values(), ...registry.invalidFiles.values()]
          .map(f => ({ path: f.path, name: f.name, content: f.content }))
      : []
    if (registry && selectedFilePath) {
      (registry as any).setDefaultFile?.(selectedFilePath)
    }

    // Send scan result with default file path so the webview can compute initial selection
    panel.webview.postMessage({ type: 'gts-scan-result', detail: { files, defaultFilePath: selectedFilePath } })

    // Full validation results for the viewer, taken from the shared registry.
    // They are already current: the scan's workspace pass validated everything,
    // and edits re-validate the edited file and its dependents before the viewer
    // is refreshed (see handleFileChange). The viewer used to build a second
    // registry and re-run Ajv over the whole workspace on every debounced edit.
    const objs: ObjValidationDto[] = registry ? Array.from(registry.jsonObjs.values()).map(o => ({ id: o.id, listSequence: o.listSequence, filePath: o.file?.path, schemaId: o.schemaId, validation: o.validation })) : []
    const schemas: EntityValidationDto[] = registry ? Array.from(registry.jsonSchemas.values()).map(s => ({ id: s.id, filePath: s.file?.path, validation: s.validation })) : []
    const invalidFiles: InvalidFileValidationDto[] = registry ? Array.from(registry.invalidFiles.values()).map(f => ({ path: f.path, name: f.name, validation: f.validation })) : []
    const payload: ValidationRelayPayload = { objs, schemas, invalidFiles }
    panel.webview.postMessage({ type: 'gts-validation-result', detail: payload })

    // After scan + validation updates are delivered, instruct the webview to refresh diagrams for the updated file
    if (refreshFilePath) {
      panel.webview.postMessage({ type: 'gts-refresh-layout', detail: { filePath: refreshFilePath } })
    }
  } catch (error: any) {
    console.error('[GTS] Posting registry to viewer failed:', error)
    panel.webview.postMessage({ type: 'gts-scan-error', detail: { error: error.message || String(error) } })
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[GTS] Extension activating...')

  initValidation(context)

  // Initialize and register GTS link provider for clickable GTS IDs
  gtsLinkProvider = new GtsLinkProvider()

  // Repaint editor decorations whenever document validation completes
  context.subscriptions.push(
    onValidationCompleted(uri => {
      gtsLinkProvider?.updateDecorationsForUri(uri)
    })
  )

  // Left sidebar: file browser tree + red/green file decorations, sharing the same registry.
  gtsExplorer = registerGtsExplorer(context)

  // Register link provider for JSON, JSONC, and GTS files
  const documentSelector: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file' },
    { language: 'jsonc', scheme: 'file' },
    { language: 'gts', scheme: 'file' },
    { language: 'yaml', scheme: 'file' }
  ]

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(documentSelector, gtsLinkProvider)
  )

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(documentSelector, gtsLinkProvider)
  )

  // Update decorations when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && gtsLinkProvider) {
        gtsLinkProvider.updateDecorations(editor)
      }
    })
  )

  // Document changes are handled by handleFileChange (registered below), which
  // incrementally updates the shared registry and repaints decorations.

  // Keep the shared registry in sync with on-disk changes that don't go through
  // the editor: files edited outside the IDE (git pull/checkout, terminal,
  // external tools).
  const gtsWatcher = vscode.workspace.createFileSystemWatcher(GTS_SCAN_GLOB)
  context.subscriptions.push(gtsWatcher)
  context.subscriptions.push(
    gtsWatcher.onDidCreate(uri => { void onDiskFileChanged(uri) }),
    gtsWatcher.onDidChange(uri => { void onDiskFileChanged(uri) }),
    gtsWatcher.onDidDelete(uri => { onDiskPathRemoved(uri) })
  )

  // Folder-level on-disk changes (rm -rf, mv, git checkout of a directory).
  // VS Code reports a folder delete/move as ONE event for the folder itself —
  // never for the files inside — and the GTS glob above never matches a folder,
  // so without this every file under a removed folder stays indexed (ghost
  // entries in the tree and in reference resolution) until a full refresh.
  const folderWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false)
  context.subscriptions.push(
    folderWatcher,
    folderWatcher.onDidCreate(uri => {
      if (isGtsScanPath(uri.fsPath)) return // file: handled by gtsWatcher
      if (isExcludedFolder(uri)) return
      void (async () => {
        if (await isDirectory(uri)) scheduleFolderScan(uri.fsPath)
      })()
    }),
    folderWatcher.onDidDelete(uri => {
      if (isGtsScanPath(uri.fsPath)) return // file: handled by gtsWatcher
      if (isAlwaysExcluded(uri.fsPath)) return
      onDiskPathRemoved(uri)
    })
  )

  // The recursive workspace watcher above does NOT follow directory symlinks
  // that resolve outside the watched folder, so files reached only through such
  // a symlink (e.g. `.examples -> ../gts-spec/...`) never emit create/change/
  // delete events. Add an explicit recursive watcher rooted at each symlinked
  // directory so external OS edits under it are tracked too.
  void watchSymlinkedDirs(context)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void watchSymlinkedDirs(context) })
  )

  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles(event => {
      for (const uri of event.files) {
        if (!isGtsScanPath(uri.fsPath)) continue
        const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === uri.fsPath)
        if (openDoc) {
          handleFileChange(openDoc, 0)
        } else {
          void onDiskFileChanged(uri)
        }
      }
    }),
    // In-IDE deletes; a deleted folder arrives as a single folder URI.
    vscode.workspace.onDidDeleteFiles(event => {
      for (const uri of event.files) onDiskPathRemoved(uri)
    }),
    // Closing a document discards unsaved edits (validation.ts reindexes it from
    // disk). If a scan read the old buffer, re-sync the file after it commits.
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (isGtsCandidateFile(doc)) pathsTouchedDuringScan?.add(doc.uri.fsPath)
    })
  )

  // Handle in-IDE renames explicitly: the watcher's create event is skipped for
  // files open in the editor, and no text-change event fires on rename, so the
  // new path would otherwise stay unindexed. A renamed/moved folder arrives as a
  // single folder URI pair, so everything under it is moved over. (External
  // renames arrive as delete+create through the watchers and are handled above.)
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async event => {
      for (const { oldUri, newUri } of event.files) {
        dropIndexedPath(oldUri.fsPath)
        if (isAlwaysExcluded(newUri.fsPath)) continue
        if (!isGtsScanPath(newUri.fsPath)) {
          if (await isDirectory(newUri)) await indexFolder(newUri)
          continue
        }
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === newUri.fsPath)
        if (openDoc) {
          handleFileChange(openDoc, 0)
        } else {
          await onDiskFileChanged(newUri)
        }
      }
      // Repaint even when nothing was re-indexed (e.g. renamed to a non-GTS name).
      gtsExplorer?.refresh()
      scheduleExternalChangeSettle()
    })
  )

  // When any .gitignore changes, reload the ignore rules and rescan so newly
  // ignored/unignored files are applied everywhere.
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore')
  context.subscriptions.push(gitignoreWatcher)
  const onGitignoreChanged = () => {
    resetWorkspaceIgnore()
    void performInitialScan()
  }
  context.subscriptions.push(
    gitignoreWatcher.onDidCreate(onGitignoreChanged),
    gitignoreWatcher.onDidChange(onGitignoreChanged),
    gitignoreWatcher.onDidDelete(onGitignoreChanged)
  )

  // Perform initial workspace scan for validation (background, non-blocking)
  console.log('[GTS] Starting initial workspace scan for validation...')
  performInitialScan().catch(error => {
    console.error('[GTS] Initial scan failed:', error)
  })

  // Initial decoration for all visible editors
  if (gtsLinkProvider) {
    for (const editor of vscode.window.visibleTextEditors) {
      gtsLinkProvider.updateDecorations(editor)
    }
  }

  console.log('[GTS] Link provider registered for JSON/JSONC/GTS files')

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gts-kit.openViewer', (resource?: vscode.Uri) => {
      openViewer(context, resource)
    }),
    vscode.commands.registerCommand('gts-kit.refreshFileExplorer', async () => {
      try {
        await refreshGtsFileExplorer()
      } catch (error: any) {
        console.error('[GTS] Full refresh failed:', error)
        vscode.window.showErrorMessage(`Failed to refresh GTS files: ${error?.message || String(error)}`)
      }
    })
  )

  // Register command to replace erroneous GTS ID with suggestion
  context.subscriptions.push(
    vscode.commands.registerCommand('gts.replaceGtsId', async (documentUri: string, rangeData: any, newText: string, includeQuotes: boolean) => {
      try {
        const uri = vscode.Uri.parse(documentUri)
        const document = await vscode.workspace.openTextDocument(uri)
        const editor = await vscode.window.showTextDocument(document)

        // Reconstruct the Range from serialized data
        let range = new vscode.Range(
          rangeData.start.line,
          rangeData.start.character,
          rangeData.end.line,
          rangeData.end.character
        )

        // If we need to include quotes, extend the range and wrap the text
        let replacementText = newText
        if (includeQuotes) {
          // Extend range to include the quotes (one character before and after)
          range = new vscode.Range(
            rangeData.start.line,
            rangeData.start.character - 1,
            rangeData.end.line,
            rangeData.end.character + 1
          )
          replacementText = `"${newText}"`
        }

        await editor.edit(editBuilder => {
          editBuilder.replace(range, replacementText)
        })

        // Show success message
        vscode.window.showInformationMessage(`Replaced with: ${newText}`)
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to replace GTS ID: ${error}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      handleFileChange(doc, 0)
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      handleFileChange(event.document, 500)
    })
  )
}

/** Paths of GTS-candidate files currently open in the editor (active first). */
function collectOpenGtsPaths(): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const add = (fsPath: string) => {
    if (!seen.has(fsPath)) { seen.add(fsPath); ordered.push(fsPath) }
  }
  const active = vscode.window.activeTextEditor?.document
  if (active && active.uri.scheme === 'file' && isGtsCandidateFile(active)) add(active.uri.fsPath)
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.scheme === 'file' && isGtsCandidateFile(ed.document)) add(ed.document.uri.fsPath)
  }
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme === 'file' && isGtsCandidateFile(d)) add(d.uri.fsPath)
  }
  return ordered
}

/**
 * Read the given files, keeping only those that can contain a GTS id.
 *
 * The `gts.` substring pre-filter avoids parsing the (potentially huge) majority
 * of JSON files that have nothing to do with GTS. For files open in the editor we
 * use the live buffer so unsaved edits are reflected.
 */
async function readGtsCandidateFiles(
  uris: vscode.Uri[]
): Promise<Array<{ path: string; name: string; content: any }>> {
  // Only real files: a git:/ quick-diff document shares the fsPath but holds HEAD content.
  const openDocs = new Map(vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file').map(d => [d.uri.fsPath, d]))
  const results = await mapWithConcurrency(uris, FILE_READ_CONCURRENCY, async uri => {
    try {
      const openDoc = openDocs.get(uri.fsPath)
      const text = openDoc ? openDoc.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
      // Quick pre-filter: a file with no GTS-like substring cannot hold a GTS id.
      // Check for both "gts." (canonical form) and "gts://" (URI form) so that
      // malformed identifiers like "gts://gtx.foo.bar.v1~" are still surfaced.
      if (!mayContainGts(text)) return null
      const name = path.basename(uri.fsPath)
      let content: any
      try { content = parseGtsFileContent(name, text) } catch { content = text }
      return { path: uri.fsPath, name, content }
    } catch {
      return null // Unreadable file — skip.
    }
  })
  // Results keep input order, so indexing order (and thus which definition of a
  // duplicated id wins) is the same as with sequential reads.
  return results.filter((f): f is { path: string; name: string; content: any } => f !== null)
}

// Files read concurrently during a scan. Sequential reads left most of the scan
// waiting on I/O one file at a time.
const FILE_READ_CONCURRENCY = 32

/** Map over `items` with at most `limit` operations in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Re-validate all open GTS documents against the current registry. */
function revalidateOpenDocs(): void {
  vscode.workspace.textDocuments.forEach(doc => {
    if (isGtsCandidateFile(doc)) void validateOpenDocument(doc)
  })
}

/**
 * Tear the GTS store all the way down to empty: drop every registry entity,
 * the symlink-dedup index, the .gitignore cache, cached scan files, and all
 * validation/link diagnostics, then repaint the (now empty) tree and
 * decorations. A subsequent scan repopulates everything from a fresh
 * enumeration, so entities for files/directories removed since the last scan
 * cannot survive as stale ("ghost") entries. Does NOT itself scan.
 */
async function resetGtsStore(): Promise<void> {
  fileMutationRevisions.clear()
  clearChangeTimers()
  if (externalChangeTimer) clearTimeout(externalChangeTimer)
  externalChangeTimer = null
  preEditIdsByPath.clear()
  realPathIndex.clear()
  resetWorkspaceIgnore()
  setLastScanFiles([])
  await rebuildRegistry([], DEFAULT_GTS_CONFIG)
  resetValidationDiagnostics()
  gtsExplorer?.reset()
  await gtsLinkProvider?.refresh()
}

async function refreshGtsFileExplorer(): Promise<void> {
  pendingOpenFile = null
  await performInitialScan(true)
}

/**
 * Queue a full two-phase workspace scan (optionally from an emptied store, so
 * nothing from before can survive). Shows progress on the GTS files view.
 */
async function performInitialScan(reset: boolean = false): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: 'gts-kit.fileExplorer' }, title: 'Scanning GTS files' },
    () => enqueueScan(async () => {
      // Reset inside the queue so it can't interleave with a scan in flight.
      if (reset) await resetGtsStore()
      pathsTouchedDuringScan = new Set()
      try {
        await performInitialScanPass()
      } finally {
        pathsTouchedDuringScan = null
      }
    })
  )
}

async function performInitialScanPass(): Promise<void> {
  const startTime = Date.now()
  try {
    // Load .gitignore rules first so both phases permanently exclude ignored
    // files/folders (at enumeration time via globs, plus an authoritative
    // matcher for edge cases such as negations and nested ignores).
    const ignores = await getWorkspaceIgnore()
    const openPaths = collectOpenGtsPaths()

    // A full scan re-establishes the canonical set of physical files.
    realPathIndex.clear()

    // --- Phase 1: fast pass -------------------------------------------------
    // Enumerate with FAST_EXCLUDE_GLOB (+ gitignore) so build-output/dependency
    // trees (target, node_modules, ...) and ignored paths aren't even walked.
    // Also skip known framework files by name. Currently-open files are always
    // included and go first so the file you are looking at colors ASAP (an open
    // file is an explicit user action, so it is coloured even if gitignored).
    const fastUris = await findGtsFiles(ignores, FAST_EXCLUDE_GLOB, PHASE1_FILE_CAP)
    const phase1Candidates: vscode.Uri[] = []
    const phase1Paths = new Set<string>()
    for (const p of openPaths) {
      phase1Candidates.push(vscode.Uri.file(p))
      phase1Paths.add(p)
    }
    for (const uri of fastUris) {
      if (phase1Paths.has(uri.fsPath)) continue
      if (isDeferredToPhase2(uri.fsPath)) continue
      if (isExcludedFile(uri, ignores)) continue
      phase1Candidates.push(uri)
      phase1Paths.add(uri.fsPath)
    }

    // Collapse symlinked duplicates to one physical file each (open files first,
    // so they stay canonical).
    const phase1Deduped = dedupeUrisByRealPath(phase1Candidates)
    console.log(`[GTS] Phase 1: ${phase1Deduped.length} candidate files (of ${fastUris.length} enumerated, ${phase1Candidates.length} before real-path dedup)`)
    const files1 = await readGtsCandidateFiles(phase1Deduped)
    const registry = await rebuildRegistry(files1, DEFAULT_GTS_CONFIG)
    // Keep recording: phase 2 below may also race with live changes.
    await resyncPathsTouchedDuringScan(true)
    setLastScanFiles(files1)
    console.log(`[GTS] Phase 1 registry: ${registry.jsonSchemas.size} schemas, ${registry.jsonObjs.size} objects (${files1.length} GTS files)`)
    gtsExplorer?.refresh()

    // Paint decorations + validate now that phase-1 registry is available.
    // Validate the whole workspace (not just the folders of currently-open docs)
    // so all findings/badge counts are present immediately after a window reload.
    await gtsLinkProvider?.refresh()
    await validateWorkspaceInBackground()
    revalidateOpenDocs()

    // --- Phase 2: background pass -------------------------------------------
    // Enumerate the full set (only .git / our cache + gitignore excluded) and
    // process whatever phase 1 didn't: non-ignored deferred dirs and framework
    // files. Runs after the UI is already coloured, so its cost is not visible.
    const allUris = await findGtsFiles(ignores, ALWAYS_EXCLUDE_GLOB)
    // Skip anything already indexed in phase 1 and any symlinked duplicate of a
    // physical file we've already taken (the realPathIndex still holds phase 1).
    const phase2Prefiltered = allUris.filter(uri => !phase1Paths.has(uri.fsPath) && !isExcludedFile(uri, ignores))
    const phase2Uris = dedupeUrisByRealPath(phase2Prefiltered)
    const files2 = phase2Uris.length > 0 ? await readGtsCandidateFiles(phase2Uris) : []
    for (const f of files2) indexFileInRegistry(f.path, f.name, f.content)
    if (files2.length > 0) setLastScanFiles([...files1, ...files2])
    console.log(`[GTS] Phase 2: merged ${files2.length} GTS files (of ${phase2Uris.length} deferred)`)
    const resynced = await resyncPathsTouchedDuringScan(false)
    if (files2.length > 0 || resynced > 0) {
      gtsExplorer?.refresh()
      await gtsLinkProvider?.refresh()
      await validateWorkspaceInBackground()
      revalidateOpenDocs()
    }
    const finalRegistry = getRegistry()
    console.log(`[GTS] Scan complete in ${Date.now() - startTime}ms: ${finalRegistry?.jsonFiles.size ?? 0} GTS files, ${finalRegistry?.invalidFiles.size ?? 0} unparsable`)
  } catch (error) {
    console.error('[GTS] Initial scan error:', error)
    throw error
  }
}

export async function deactivate() {
  console.log('[GTS] Extension deactivating...')

  if (viewerPanel) {
    viewerPanel.dispose()
    viewerPanel = null
  }

  if (gtsLinkProvider) {
    gtsLinkProvider.dispose()
    gtsLinkProvider = null
  }

  gtsExplorer = null
  layoutStorage = null
}

// Per-file debounce timers for editor changes. One shared timer meant editing
// file B within the debounce window cancelled file A's pending validation and
// dependents revalidation, leaving A's markers stale.
const changeTimers = new Map<string, NodeJS.Timeout>()

function clearChangeTimers(): void {
  for (const timer of changeTimers.values()) clearTimeout(timer)
  changeTimers.clear()
}

function isGtsScanPath(fsPath: string): boolean {
  return /\.(json|jsonc|gts|ya?ml)$/i.test(fsPath)
}

// Symlinked directories we've already attached a dedicated watcher to (keyed by
// the symlink's fsPath), so repeated setup calls don't create duplicate watchers.
const watchedSymlinkDirs = new Set<string>()

/**
 * VS Code's recursive workspace watcher does not follow directory symlinks that
 * point outside the watched folder. Create an explicit recursive watcher rooted
 * at each top-level symlinked directory in every workspace folder so on-disk
 * create/change/delete events under it are reported. VS Code preserves the
 * watched (symlink) path in the emitted URIs, which matches how the scan indexes
 * those files, so no path translation is needed.
 */
async function watchSymlinkedDirs(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders || []
  for (const folder of folders) {
    let entries: [string, vscode.FileType][]
    try {
      entries = await vscode.workspace.fs.readDirectory(folder.uri)
    } catch {
      continue
    }
    for (const [name, type] of entries) {
      if (!(type & vscode.FileType.SymbolicLink)) continue
      const linkUri = vscode.Uri.joinPath(folder.uri, name)
      if (watchedSymlinkDirs.has(linkUri.fsPath)) continue
      // Only follow symlinks that resolve to a directory (stat follows the link).
      try {
        const stat = await vscode.workspace.fs.stat(linkUri)
        if (!(stat.type & vscode.FileType.Directory)) continue
      } catch {
        continue
      }
      if (isExcludedFolder(linkUri)) continue
      watchedSymlinkDirs.add(linkUri.fsPath)
      const pattern = new vscode.RelativePattern(linkUri, `**/*.{json,jsonc,gts,yaml,yml}`)
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      context.subscriptions.push(
        watcher,
        watcher.onDidCreate(uri => { void onDiskFileChanged(uri) }),
        watcher.onDidChange(uri => { void onDiskFileChanged(uri) }),
        watcher.onDidDelete(uri => { onDiskPathRemoved(uri) })
      )
      console.log('[GTS] Watching symlinked directory:', linkUri.fsPath)
    }
  }
}

/** True if the file is currently open as a text document (editor owns its content). */
function isOpenInEditor(fsPath: string): boolean {
  return vscode.workspace.textDocuments.some(d => d.uri.fsPath === fsPath)
}

/**
 * A GTS file was created or changed on disk. Reindex it from disk into the shared
 * registry, unless it's open in the editor — in that case the editor handlers own
 * the (possibly unsaved) live content and must not be clobbered by the disk copy.
 */
async function onDiskFileChanged(uri: vscode.Uri): Promise<void> {
  const fsPath = uri.fsPath
  if (isExcludedFile(uri)) return
  if (isOpenInEditor(fsPath)) return
  const mutationRevision = beginFileMutation(fsPath)
  try {
    const data = await vscode.workspace.fs.readFile(uri)
    const text = Buffer.from(data).toString('utf8')
    if (fileMutationRevisions.get(fsPath) !== mutationRevision || !fs.existsSync(fsPath)) return
    // Same pre-filter as the full scan, so a changed non-GTS JSON file (e.g. a
    // broken build artifact) never shows up in the tree, and a file whose GTS
    // content was removed drops out of it.
    if (mayContainGts(text)) {
      // Keep one entry per physical file even when reached via a symlinked path.
      indexFileText(fsPath, text)
    } else {
      dropFileFromRegistry(fsPath)
    }
    gtsExplorer?.refresh()
  } catch (e) {
    console.error('[GTS] Failed to reindex changed file from disk:', fsPath, e)
    return
  }
  scheduleExternalChangeSettle()
}

/** Indexed file paths (GTS files and unparsable ones) strictly under `dirPath`. */
function indexedPathsUnder(dirPath: string): string[] {
  const registry = getRegistry()
  if (!registry) return []
  const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep
  const out: string[] = []
  for (const p of [...registry.jsonFiles.keys(), ...registry.invalidFiles.keys()]) {
    if (p.startsWith(prefix)) out.push(p)
  }
  return out
}

/**
 * Drop a removed path from the registry: the file itself, or — when it was a
 * folder — every indexed file under it. Returns whether anything was indexed.
 */
function dropIndexedPath(fsPath: string): boolean {
  // A GTS-named path is always marked, even if not indexed yet, so an in-flight
  // onDiskFileChanged read for it can't resurrect it.
  const targets = isGtsScanPath(fsPath) ? [fsPath, ...indexedPathsUnder(fsPath)] : indexedPathsUnder(fsPath)
  for (const p of targets) {
    beginFileMutation(p)
    dropFileFromRegistry(p)
  }
  return targets.length > 0
}

/** A file or folder was deleted/renamed-away. Drop its entities from the registry. */
function onDiskPathRemoved(uri: vscode.Uri): void {
  if (!dropIndexedPath(uri.fsPath)) return
  gtsExplorer?.refresh()
  scheduleExternalChangeSettle()
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0
  } catch {
    return false
  }
}

/** Index every GTS file under a folder that just appeared (created, moved in, renamed). */
async function indexFolder(uri: vscode.Uri): Promise<void> {
  if (isExcludedFolder(uri)) return
  // Exclude globs are matched relative to the containing workspace folder, so
  // that folder's .gitignore globs apply here too.
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  const ignoreGlobs = workspaceFolder ? (await getWorkspaceIgnore()).get(workspaceFolder.uri.fsPath)?.excludeGlobs || [] : []
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, GTS_SCAN_GLOB), combineExcludeGlobs(ALWAYS_EXCLUDE_GLOB, ignoreGlobs))
  // onDiskFileChanged applies the ignore rules and skips files open in an editor.
  await mapWithConcurrency(uris, FILE_READ_CONCURRENCY, fileUri => onDiskFileChanged(fileUri))
}

// Folders reported as created, batched so a burst (git checkout, unzip) scans
// each new top-level folder once instead of once per nested directory.
const pendingNewFolders = new Set<string>()
let newFolderTimer: NodeJS.Timeout | null = null

function scheduleFolderScan(fsPath: string): void {
  pendingNewFolders.add(fsPath)
  if (newFolderTimer) clearTimeout(newFolderTimer)
  newFolderTimer = setTimeout(() => {
    newFolderTimer = null
    const folders = [...pendingNewFolders].sort()
    pendingNewFolders.clear()
    const roots = folders.filter((f, i) => !folders.slice(0, i).some(r => f.startsWith(r + path.sep)))
    void (async () => {
      for (const folder of roots) await indexFolder(vscode.Uri.file(folder))
    })()
  }, 300)
}

// Debounce a burst of on-disk changes (e.g. a git checkout touching many files)
// into a single UI/validation refresh.
let externalChangeTimer: NodeJS.Timeout | null = null
const fileMutationRevisions = new Map<string, number>()

function beginFileMutation(fsPath: string): number {
  pathsTouchedDuringScan?.add(fsPath)
  const revision = (fileMutationRevisions.get(fsPath) || 0) + 1
  fileMutationRevisions.set(fsPath, revision)
  return revision
}

function scheduleExternalChangeSettle(): void {
  if (externalChangeTimer) clearTimeout(externalChangeTimer)
  externalChangeTimer = setTimeout(() => {
    // Repaint + refresh workspace diagnostics and then re-validate open docs with
    // precise ranges. A burst of on-disk changes can touch files anywhere in the
    // repo (git checkout, external tools), so validate the whole workspace rather
    // than only the currently-focused folders.
    void (async () => {
      await gtsLinkProvider?.refresh()
      await validateWorkspaceInBackground()
      revalidateOpenDocs()
      if (viewerPanel) await scanAndPost()
    })()
  }, 300)
}

// Ids each file defined *before* the current burst of edits, captured prior to
// the first reindex so a renamed/removed id still revalidates its old referrers.
// Keyed by fsPath; an entry is removed when that file's debounced revalidation fires.
const preEditIdsByPath = new Map<string, Set<string>>()

function handleFileChange(doc: vscode.TextDocument, delayMsec: number = 500) {
  if (!isGtsCandidateFile(doc)) return

  const fsPath = doc.uri.fsPath
  beginFileMutation(fsPath)

  // Snapshot the file's ids from before this edit burst (once per burst), before
  // the immediate reindex below overwrites them in the registry.
  if (!preEditIdsByPath.has(fsPath)) {
    const registry = getRegistry()
    preEditIdsByPath.set(fsPath, new Set(registry?.getEntityIdsForFile(fsPath) || []))
  }

  // Immediate + cheap: keep the shared registry index and the editor's color
  // annotations in sync with the live document as the user types. No Ajv here.
  try {
    const text = doc.getText()
    const name = path.basename(fsPath)
    let content: any
    try { content = parseGtsFileContent(name, text) } catch { content = text }
    // Ensure this physical file is indexed under exactly this (open) path.
    claimCanonicalPath(fsPath)
    indexFileInRegistry(fsPath, name, content)
    gtsExplorer?.refresh()
  } catch (e) {
    console.error('[GTS] Incremental index failed:', e)
  }
  const editor = vscode.window.activeTextEditor
  if (editor && editor.document === doc && gtsLinkProvider) {
    gtsLinkProvider.updateDecorations(editor)
  }

  // Debounced + heavier: validate just this document and its dependents, then
  // (only when the viewer panel is open) push the updated registry to it, so
  // the viewer gets results that already reflect this edit.
  const pending = changeTimers.get(fsPath)
  if (pending) clearTimeout(pending)
  changeTimers.set(fsPath, setTimeout(() => {
    changeTimers.delete(fsPath)
    const previousIds = preEditIdsByPath.get(fsPath)
    preEditIdsByPath.delete(fsPath)
    void (async () => {
      await validateOpenDocument(doc)
      // Re-check everything that depends on this file (derived/instantiated
      // types, $ref/allOf composers, and GTS-id referrers) so their markers
      // reflect the edit, not just this doc.
      await revalidateDependents(fsPath, previousIds)
      if (viewerPanel) await scanAndPost(fsPath)
    })()
  }, delayMsec))
}

/** Root of the workspace folder that holds the target entity's file (first folder if unknown). */
function layoutRootFor(target: Partial<LayoutTarget>): string {
  const registry = getRegistry()
  const entity = target.id ? (registry?.jsonSchemas.get(target.id) || registry?.jsonObjs.get(target.id)) : undefined
  const folder = entity?.file?.path ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entity.file.path)) : undefined
  return (folder ?? vscode.workspace.workspaceFolders![0]).uri.fsPath
}

function openViewer(context: vscode.ExtensionContext, resource?: vscode.Uri) {
  // If viewer already exists, just reveal it (do not change selection or default file)
  if (viewerPanel) {
    // If the command was invoked on a specific file (context menu), ask the webview to switch to it
    const activeDoc = vscode.window.activeTextEditor?.document
    const requestedPath = resource?.fsPath || (activeDoc && isGtsCandidateFile(activeDoc) ? activeDoc.uri.fsPath : undefined)
    if (requestedPath) {
      try {
        viewerPanel.webview.postMessage({ type: 'gts-select-file', detail: { filePath: requestedPath } })
      } catch {}
    }
    viewerPanel.reveal(vscode.ViewColumn.One)
    return
  }

  // Determine the file to open and capture it for initial scan (only when creating new viewer)
  const activeDoc = vscode.window.activeTextEditor?.document
  const selectedPath = resource?.fsPath
    || (activeDoc && isGtsCandidateFile(activeDoc) ? activeDoc.uri.fsPath : undefined)

  // Store so the first scanAndPost picks it up as defaultFilePath
  pendingOpenFile = selectedPath || null

  // Layouts live in the .gts-viewer/ folder of the workspace folder that holds
  // the diagram's entity (multi-root), falling back to the first folder.
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Please open a workspace folder to use GTS Viewer')
    return
  }
  layoutStorage = new WorkspaceLayoutStorage(layoutRootFor)

  viewerPanel = vscode.window.createWebviewPanel(
    'gtsViewer',
    'GTS Viewer',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview'))
      ]
    }
  )

  // Handle messages from webview
  viewerPanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.type) {
        case 'getLatestLayout':
          try {
            const snapshot = await layoutStorage!.getLatestLayout(message.target)
            viewerPanel!.webview.postMessage({
              type: 'getLatestLayoutResponse',
              id: message.id,
              result: snapshot
            })
          } catch (error: any) {
            viewerPanel!.webview.postMessage({
              type: 'getLatestLayoutResponse',
              id: message.id,
              error: error.message
            })
          }
          break

        case 'saveLayout':
          try {
            const snapshot = await layoutStorage!.saveLayout(message.request)
            viewerPanel!.webview.postMessage({
              type: 'saveLayoutResponse',
              id: message.id,
              result: snapshot
            })
          } catch (error: any) {
            viewerPanel!.webview.postMessage({
              type: 'saveLayoutResponse',
              id: message.id,
              error: error.message
            })
          }
          break

        case 'scanWorkspaceJson': {
          try {
            const isInitialScan = !hasPerformedInitialScan
            hasPerformedInitialScan = true
            // The first request (viewer just opened) is served from the registry
            // the background scan already maintains. A later, user-triggered
            // rescan rebuilds the whole GTS store from scratch, so entities for
            // files/directories removed since the last scan can't linger.
            await scanAndPost(undefined, !isInitialScan)
          } catch (error: any) {
            viewerPanel!.webview.postMessage({ type: 'gts-scan-error', detail: { error: error.message || String(error) } })
          }
          break
        }

        case 'openFile': {
          try {
            const filePath = message.filePath
            if (filePath) {
              const uri = vscode.Uri.file(filePath)
              await vscode.window.showTextDocument(uri, { preview: false })
            }
          } catch (error: any) {
            console.error('[GTS] Error opening file:', error)
            vscode.window.showErrorMessage(`Failed to open file: ${error.message || String(error)}`)
          }
          break
        }
      }
    },
    undefined,
    context.subscriptions
  )

  // Load the web app
  const webviewPath = path.join(context.extensionPath, 'dist', 'webview')
  const indexPath = path.join(webviewPath, 'index.html')

  // Read the HTML file
  const fs = require('fs')
  let html = fs.readFileSync(indexPath, 'utf8')

  // Note: Default file will be determined and passed via scan result, not injected here
  if (selectedPath) {
    console.log(`[GTS Extension] Opening viewer with active file: ${selectedPath}`)
  } else {
    console.log(`[GTS Extension] Opening viewer with no active JSON/GTS file`)
  }
  // Replace asset paths to use webview URIs
  const assetUri = viewerPanel.webview.asWebviewUri(
    vscode.Uri.file(webviewPath)
  )

  // Inject the App API configuration with message-based layout storage
  const nonce = getNonce()
  html = html.replace(
    '<head>',
    `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${viewerPanel.webview.cspSource} blob: data:; script-src ${viewerPanel.webview.cspSource} 'nonce-${nonce}'; style-src ${viewerPanel.webview.cspSource} 'unsafe-inline'; font-src ${viewerPanel.webview.cspSource}; connect-src ${viewerPanel.webview.cspSource} https://* http://*;">
    <script nonce="${nonce}">
      // Inject unified App API with message-based layout storage
      const vscodeApi = acquireVsCodeApi();
      let messageId = 0;
      const pendingMessages = new Map();

      // Listen for responses from extension
      window.addEventListener('message', (event) => {
        const message = event.data;
        // Dispatch custom GTS events to the app as DOM CustomEvents
        if (message && typeof message.type === 'string' && message.type.startsWith('gts-')) {
          const evt = new CustomEvent(message.type, { detail: message.detail });
          window.dispatchEvent(evt);
        }
        if (message && message.id && pendingMessages.has(message.id)) {
          const { resolve, reject } = pendingMessages.get(message.id);
          pendingMessages.delete(message.id);
          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message.result);
          }
        }
      });

      window.__GTS_APP_API__ = {
        type: 'vscode',
        layoutStorage: {
          async getLatestLayout(target) {
            const id = messageId++;
            return new Promise((resolve, reject) => {
              pendingMessages.set(id, { resolve, reject });
              vscodeApi.postMessage({ type: 'getLatestLayout', id, target });
            });
          },
          async saveLayout(request) {
            const id = messageId++;
            return new Promise((resolve, reject) => {
              pendingMessages.set(id, { resolve, reject });
              vscodeApi.postMessage({ type: 'saveLayout', id, request });
            });
          }
        },
        scanWorkspaceJson(opts) {
          const id = messageId++;
          // fire-and-forget; results come via gts-scan-* events
          vscodeApi.postMessage({ type: 'scanWorkspaceJson', id, options: opts || {} });
        },
        openFile(filePath) {
          // fire-and-forget; open file in VS Code editor
          vscodeApi.postMessage({ type: 'openFile', filePath });
        },
        // Trigger auto-scan on load
        autoScan: true
      };
    </script>`
  )

  // Fix asset paths
  html = html.replace(/src="\//g, `src="${assetUri}/`)
  html = html.replace(/href="\//g, `href="${assetUri}/`)

  viewerPanel.webview.html = html

  // Notify webview to select the initially requested file (from context menu or active editor)
  if (selectedPath) {
    try {
      viewerPanel.webview.postMessage({ type: 'gts-select-file', detail: { filePath: selectedPath } })
    } catch {}
  }

  console.log('[GTS] Viewer panel created. Subscribing to file changes...')

  // Handle viewer panel disposal
  viewerPanel.onDidDispose(() => {
    console.log('[GTS] Viewer panel disposed')
    viewerPanel = null
    layoutStorage = null
    hasPerformedInitialScan = false // Reset for next viewer session
    pendingOpenFile = null
  }, null, context.subscriptions)
}
