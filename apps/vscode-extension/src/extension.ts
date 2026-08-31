import * as vscode from 'vscode'
import * as path from 'path'
import { parseJSONC, JsonRegistry, DEFAULT_GTS_CONFIG } from '@gts/shared'
import { setLastScanFiles } from './scanStore'
import { rebuildRegistry, indexFile as indexFileInRegistry, removeFile as removeFileFromRegistry } from './registryStore'
import { getWorkspaceIgnore, resetWorkspaceIgnore, getCachedMatcher, isIgnoredRel } from './gitignore'
import { RepoLayoutStorage } from './storage'
import { initValidation, validateOpenDocument } from './validation'
import { isGtsCandidateFile } from './helpers'
import { GtsLinkProvider } from './linkProvider'
import type { LayoutSaveRequest, LayoutTarget, LayoutSnapshot } from '@gts/layout-storage'

// Glob used for all GTS workspace scans and the on-disk file watcher.
const GTS_SCAN_GLOB = '**/*.{json,jsonc,gts,yaml,yml}'

// Directories that never contain user GTS entities and are huge/binary — excluded
// from every scan (both phases).
const ALWAYS_EXCLUDE_GLOB = '**/{.git,.gts-viewer}/**'

// Fast-pass exclude: also drops build-output / dependency directories so their
// (often enormous) trees aren't even enumerated on the first, latency-sensitive
// pass. Applied at the findFiles level.
const FAST_EXCLUDE_GLOB = '**/{.git,.gts-viewer,node_modules,target,build,out,dist,.next,.nuxt,.svelte-kit,coverage,vendor,bin,obj,__pycache__}/**'

// Build-output / dependency directories skipped on the fast first pass and only
// looked at on the second (background) pass.
const PHASE2_DIR_RE = /[\\/](node_modules|target|build|out|dist|\.next|\.nuxt|\.svelte-kit|coverage|vendor|bin|obj|__pycache__)[\\/]/i

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

/** True if the given file URI is gitignored (per the cached matcher). */
function isUriIgnored(uri: vscode.Uri, matcher = getCachedMatcher()): boolean {
  return isIgnoredRel(matcher, vscode.workspace.asRelativePath(uri, false))
}

let viewerPanel: vscode.WebviewPanel | null = null
let layoutStorage: RepoLayoutStorage | null = null
let hasPerformedInitialScan: boolean = false // Track if initial scan with default file has been done
let gtsLinkProvider: GtsLinkProvider | null = null

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

async function scanAndPost(includeGlob: string = GTS_SCAN_GLOB, isInitialScan: boolean = false, refreshFilePath?: string | null) {
  const hasViewer = viewerPanel !== null

  try {
    let selectedFilePath: string | null = null
    const activeDoc = vscode.window.activeTextEditor?.document
    selectedFilePath = (activeDoc && isGtsCandidateFile(activeDoc))
      ? activeDoc.uri.fsPath
      : null

    console.log('[GTS Extension] scanAndPost:', activeDoc, selectedFilePath)
    const include = includeGlob
    // Skip build-output/dependency dirs + gitignored paths; the substring filter
    // below drops the remaining non-GTS files so we only parse files that mention
    // GTS.
    const { matcher: ignoreMatcher, excludeGlobs: ignoreGlobs } = await getWorkspaceIgnore()
    const exclude = combineExcludeGlobs(FAST_EXCLUDE_GLOB, ignoreGlobs)
    const uris = await vscode.workspace.findFiles(include, exclude, 40000)

    const total = uris.length
    const startTime = Date.now()
    let progressShown = false

    const files: Array<{ path: string; name: string; content: any }> = []
    let processed = 0

    for (const uri of uris) {
      try {
        // Belt-and-suspenders: skip anything gitignored the glob missed.
        if (isUriIgnored(uri, ignoreMatcher)) {
          continue
        }
        const data = await vscode.workspace.fs.readFile(uri)
        const text = Buffer.from(data).toString('utf8')
        // Quick pre-filter: a file with no "gts." substring cannot hold a GTS id.
        if (!text.includes('gts.')) {
          continue
        }
        try {
          const content = parseJSONC(text)
          files.push({ path: uri.fsPath, name: path.basename(uri.fsPath), content })
        } catch (e) {
          files.push({ path: uri.fsPath, name: path.basename(uri.fsPath), content: text })
        }
      } catch (e) {
      } finally {
        processed++
        const elapsed = Date.now() - startTime
        if (hasViewer && !progressShown && elapsed > 500) {
          progressShown = true
          viewerPanel!.webview.postMessage({ type: 'gts-scan-started', detail: { total } })
        }
        if (hasViewer && progressShown && (processed % 50 === 0 || processed === total)) {
          viewerPanel!.webview.postMessage({ type: 'gts-scan-progress', detail: { processed, total } })
        }
      }
    }

    // Update the shared, persistent, index-only registry (used by decorations,
    // links, hovers and as validation resolution context). This is cheap.
    const registry = await rebuildRegistry(files, DEFAULT_GTS_CONFIG)
    if (selectedFilePath) {
      (registry as any).setDefaultFile?.(selectedFilePath)
    }

    // Send scan result with default file path so the webview can compute initial selection
    if (hasViewer) {
      viewerPanel!.webview.postMessage({ type: 'gts-scan-result', detail: { files, defaultFilePath: selectedFilePath } })
    }
    try { setLastScanFiles(files) } catch {}

    // Refresh the link provider (repaint from the shared registry)
    if (gtsLinkProvider) {
      try {
        await gtsLinkProvider.refresh()
      } catch (e) {
        console.error('[GTS] Error refreshing link provider:', e)
      }
    }

    // The viewer needs full Ajv validation results for every entity. This is the
    // only consumer that pays that cost, and only while the panel is open.
    if (hasViewer) {
      try {
        const vreg = new JsonRegistry()
        await vreg.ingestFiles(files, DEFAULT_GTS_CONFIG)
        const objs = Array.from(vreg.jsonObjs.values()).map(o => ({ id: o.id, listSequence: o.listSequence, filePath: o.file?.path, schemaId: o.schemaId, validation: o.validation }))
        const schemas = Array.from(vreg.jsonSchemas.values()).map(s => ({ id: s.id, filePath: s.file?.path, validation: s.validation }))
        const invalidFilesHost = Array.from(vreg.invalidFiles.values()).map(f => ({ path: f.path, name: f.name, validation: f.validation }))
        viewerPanel!.webview.postMessage({ type: 'gts-validation-result', detail: { objs, schemas, invalidFiles: invalidFilesHost } })
      } catch (ve: any) {
        viewerPanel!.webview.postMessage({ type: 'gts-validation-error', detail: { error: ve?.message || String(ve) } })
      }
    }

    // After scan + validation updates are delivered, instruct the webview to refresh diagrams for the updated file
    if (hasViewer && refreshFilePath) {
      try {
        viewerPanel!.webview.postMessage({ type: 'gts-refresh-layout', detail: { filePath: refreshFilePath } })
      } catch {}
    }

    // Re-validate all open documents now that we have the full registry
    console.log('[GTS] Re-validating all open documents...')
    vscode.workspace.textDocuments.forEach(doc => {
      if (isGtsCandidateFile(doc)) {
        void validateOpenDocument(doc)
      }
    })
  } catch (error: any) {
    if (hasViewer) {
      viewerPanel!.webview.postMessage({ type: 'gts-scan-error', detail: { error: error.message || String(error) } })
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[GTS] Extension activating...')

  // Perform initial workspace scan for validation (background, non-blocking)
  console.log('[GTS] Starting initial workspace scan for validation...')
  performInitialScan().catch(error => {
    console.error('[GTS] Initial scan failed:', error)
  })

  initValidation(context)

  // Create diagnostic collection for GTS validation
  const gtsDiagnostics = vscode.languages.createDiagnosticCollection('gts')
  context.subscriptions.push(gtsDiagnostics)

  // Initialize and register GTS link provider for clickable GTS IDs
  gtsLinkProvider = new GtsLinkProvider(gtsDiagnostics)

  // Register link provider for JSON, JSONC, and GTS files
  const documentSelector: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file' },
    { language: 'jsonc', scheme: 'file' },
    { language: 'gts', scheme: 'file' }
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
  // external tools) and create/rename/delete performed anywhere. The watcher
  // also fires for in-IDE saves/creates/deletes; those cases either defer to the
  // editor handlers (open documents) or are handled idempotently here.
  const gtsWatcher = vscode.workspace.createFileSystemWatcher(GTS_SCAN_GLOB)
  context.subscriptions.push(gtsWatcher)
  context.subscriptions.push(
    gtsWatcher.onDidCreate(uri => { void onDiskFileChanged(uri) }),
    gtsWatcher.onDidChange(uri => { void onDiskFileChanged(uri) }),
    gtsWatcher.onDidDelete(uri => { onDiskFileDeleted(uri) })
  )

  // Handle in-IDE renames explicitly: the watcher's create event is skipped for
  // files open in the editor, and no text-change event fires on rename, so the
  // new path would otherwise stay unindexed. (External renames arrive as
  // delete+create through the watcher and are handled above.)
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async event => {
      for (const { oldUri, newUri } of event.files) {
        removeFileFromRegistry(oldUri.fsPath)
        if (isIgnoredGtsPath(newUri.fsPath)) continue
        if (!/\.(json|jsonc|gts|ya?ml)$/i.test(newUri.fsPath)) continue
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === newUri.fsPath)
        if (openDoc) {
          handleFileChange(openDoc, 0)
        } else {
          await onDiskFileChanged(newUri)
        }
      }
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

  // Initial decoration for all visible editors
  if (gtsLinkProvider) {
    for (const editor of vscode.window.visibleTextEditors) {
      gtsLinkProvider.updateDecorations(editor)
    }
  }

  console.log('[GTS] Link provider registered for JSON/JSONC/GTS files')

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gts.openViewer', (resource?: vscode.Uri) => {
      openViewer(context, resource)
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

  // Show welcome message
  vscode.window.showInformationMessage('GTS Viewer is ready! Use "GTS: Open Viewer" to start.')
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
  const files: Array<{ path: string; name: string; content: any }> = []
  for (const uri of uris) {
    try {
      const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath)
      let text: string
      if (openDoc) {
        text = openDoc.getText()
      } else {
        const data = await vscode.workspace.fs.readFile(uri)
        text = Buffer.from(data).toString('utf8')
      }
      // Quick pre-filter: a file with no "gts." substring cannot hold a GTS id.
      if (!text.includes('gts.')) continue
      let content: any
      try { content = parseJSONC(text) } catch { content = text }
      files.push({ path: uri.fsPath, name: path.basename(uri.fsPath), content })
    } catch (e) {
      // Unreadable file — skip.
    }
  }
  return files
}

/** Re-validate all open GTS documents against the current registry. */
function revalidateOpenDocs(): void {
  vscode.workspace.textDocuments.forEach(doc => {
    if (isGtsCandidateFile(doc)) void validateOpenDocument(doc)
  })
}

async function performInitialScan() {
  try {
    // Load .gitignore rules first so both phases permanently exclude ignored
    // files/folders (at enumeration time via globs, plus an authoritative
    // matcher for edge cases such as negations and nested ignores).
    const { matcher: ignoreMatcher, excludeGlobs: ignoreGlobs } = await getWorkspaceIgnore()
    const openPaths = collectOpenGtsPaths()

    // --- Phase 1: fast pass -------------------------------------------------
    // Enumerate with FAST_EXCLUDE_GLOB (+ gitignore) so build-output/dependency
    // trees (target, node_modules, ...) and ignored paths aren't even walked.
    // Also skip known framework files by name. Currently-open files are always
    // included and go first so the file you are looking at colors ASAP (an open
    // file is an explicit user action, so it is coloured even if gitignored).
    const phase1Exclude = combineExcludeGlobs(FAST_EXCLUDE_GLOB, ignoreGlobs)
    const fastUris = await vscode.workspace.findFiles(GTS_SCAN_GLOB, phase1Exclude, 40000)
    const phase1Candidates: vscode.Uri[] = []
    const phase1Paths = new Set<string>()
    for (const p of openPaths) {
      phase1Candidates.push(vscode.Uri.file(p))
      phase1Paths.add(p)
    }
    for (const uri of fastUris) {
      if (phase1Paths.has(uri.fsPath)) continue
      if (isDeferredToPhase2(uri.fsPath)) continue
      if (isUriIgnored(uri, ignoreMatcher)) continue
      phase1Candidates.push(uri)
      phase1Paths.add(uri.fsPath)
    }

    console.log(`[GTS] Phase 1: ${phase1Candidates.length} candidate files (of ${fastUris.length} enumerated)`)
    const files1 = await readGtsCandidateFiles(phase1Candidates)
    setLastScanFiles(files1)
    const registry = await rebuildRegistry(files1, DEFAULT_GTS_CONFIG)
    console.log(`[GTS] Phase 1 registry: ${registry.jsonSchemas.size} schemas, ${registry.jsonObjs.size} objects (${files1.length} GTS files)`)

    // Paint decorations + validate open docs now — coloring is available.
    await gtsLinkProvider?.refresh()
    revalidateOpenDocs()

    // --- Phase 2: background pass -------------------------------------------
    // Enumerate the full set (only .git / our cache + gitignore excluded) and
    // process whatever phase 1 didn't: non-ignored deferred dirs and framework
    // files. Runs after the UI is already coloured, so its cost is not visible.
    const phase2Exclude = combineExcludeGlobs(ALWAYS_EXCLUDE_GLOB, ignoreGlobs)
    const allUris = await vscode.workspace.findFiles(GTS_SCAN_GLOB, phase2Exclude, 100000)
    const phase2Uris = allUris.filter(uri => !phase1Paths.has(uri.fsPath) && !isUriIgnored(uri, ignoreMatcher))
    if (phase2Uris.length > 0) {
      const files2 = await readGtsCandidateFiles(phase2Uris)
      if (files2.length > 0) {
        for (const f of files2) indexFileInRegistry(f.path, f.name, f.content)
        setLastScanFiles([...files1, ...files2])
        await gtsLinkProvider?.refresh()
        revalidateOpenDocs()
      }
      console.log(`[GTS] Phase 2: merged ${files2.length} GTS files (of ${phase2Uris.length} deferred)`)
    }
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

  layoutStorage = null
}

// Debounced rescan on change to auto-refresh layout view while typing
let changeTimer: NodeJS.Timeout | null = null

/** Paths we never index (build output, VCS internals, our own cache). */
function isIgnoredGtsPath(fsPath: string): boolean {
  return /(^|[\\/])(node_modules|\.gts-viewer|dist|\.git)[\\/]/.test(fsPath)
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
  if (isIgnoredGtsPath(fsPath)) return
  if (isUriIgnored(uri)) return
  if (isOpenInEditor(fsPath)) return
  try {
    const data = await vscode.workspace.fs.readFile(uri)
    const text = Buffer.from(data).toString('utf8')
    let content: any
    try { content = parseJSONC(text) } catch { content = text }
    indexFileInRegistry(fsPath, path.basename(fsPath), content)
  } catch (e) {
    console.error('[GTS] Failed to reindex changed file from disk:', fsPath, e)
    return
  }
  scheduleExternalChangeSettle()
}

/** A GTS file was deleted/renamed-away on disk. Drop its entities from the registry. */
function onDiskFileDeleted(uri: vscode.Uri): void {
  const fsPath = uri.fsPath
  if (isIgnoredGtsPath(fsPath)) return
  if (isUriIgnored(uri)) return
  removeFileFromRegistry(fsPath)
  scheduleExternalChangeSettle()
}

// Debounce a burst of on-disk changes (e.g. a git checkout touching many files)
// into a single UI/validation refresh.
let externalChangeTimer: NodeJS.Timeout | null = null
function scheduleExternalChangeSettle(): void {
  if (externalChangeTimer) clearTimeout(externalChangeTimer)
  externalChangeTimer = setTimeout(() => {
    if (viewerPanel) {
      // The viewer needs the full authoritative scan (also repaints + revalidates).
      void scanAndPost(GTS_SCAN_GLOB, false)
      return
    }
    // No viewer: cheaply repaint decorations and re-validate open documents, since
    // cross-file GTS references may now resolve/break differently.
    void gtsLinkProvider?.refresh()
    vscode.workspace.textDocuments.forEach(doc => {
      if (isGtsCandidateFile(doc)) void validateOpenDocument(doc)
    })
  }, 300)
}

function handleFileChange(doc: vscode.TextDocument, delayMsec: number = 500) {
  if (!isGtsCandidateFile(doc)) return

  // Immediate + cheap: keep the shared registry index and the editor's color
  // annotations in sync with the live document as the user types. No Ajv here.
  try {
    const text = doc.getText()
    let content: any
    try { content = parseJSONC(text) } catch { content = text }
    indexFileInRegistry(doc.uri.fsPath, path.basename(doc.uri.fsPath), content)
  } catch (e) {
    console.error('[GTS] Incremental index failed:', e)
  }
  const editor = vscode.window.activeTextEditor
  if (editor && editor.document === doc && gtsLinkProvider) {
    gtsLinkProvider.updateDecorations(editor)
  }

  // Debounced + heavier: validate just this document, and (only when the viewer
  // panel is open) run the full workspace rescan that feeds the webview.
  if (changeTimer) clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    void validateOpenDocument(doc)
    if (viewerPanel) {
      void scanAndPost(GTS_SCAN_GLOB, false, doc.uri.fsPath)
    }
  }, delayMsec)
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

  // Initialize layout storage with workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Please open a workspace folder to use GTS Viewer')
    return
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath
  layoutStorage = new RepoLayoutStorage(workspaceRoot)
  console.log(`[GTS] Using layout storage at: ${workspaceRoot}/.gts-viewer`)

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
            const include: string = message.options?.include || GTS_SCAN_GLOB
            const isInitialScan = !hasPerformedInitialScan
            if (isInitialScan) {
              hasPerformedInitialScan = true
            }
            await scanAndPost(include, isInitialScan)
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
  }, null, context.subscriptions)
}
