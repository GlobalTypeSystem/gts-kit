import * as vscode from 'vscode'
import * as path from 'path'
import { parseJSONC, JsonRegistry, DEFAULT_GTS_CONFIG } from '@gts/shared'
import { setLastScanFiles } from './scanStore'
import { RepoLayoutStorage } from './storage'
import { initValidation, notifyInitialScanComplete } from './validation'
import { isGtsCandidateFile } from './helpers'
import type { LayoutSaveRequest, LayoutTarget, LayoutSnapshot } from '@gts/layout-storage'

let viewerPanel: vscode.WebviewPanel | null = null
let layoutStorage: RepoLayoutStorage | null = null
let hasPerformedInitialScan: boolean = false // Track if initial scan with default file has been done

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

async function scanAndPost(includeGlob: string = '**/*.{json,jsonc,gts}', isInitialScan: boolean = false, refreshFilePath?: string | null) {
  try {
    let selectedFilePath: string | null = null
    const activeDoc = vscode.window.activeTextEditor?.document
    selectedFilePath = (activeDoc && isGtsCandidateFile(activeDoc))
      ? activeDoc.uri.fsPath
      : null

    console.log('[GTS Extension] scanAndPost:', activeDoc, selectedFilePath)
    const include = includeGlob
    const exclude = '**/{node_modules,.gts-viewer,dist,.git}/**'
    const uris = await vscode.workspace.findFiles(include, exclude, 10000)

    const total = uris.length
    const startTime = Date.now()
    let progressShown = false

    const files: Array<{ path: string; name: string; content: any }> = []
    let processed = 0

    for (const uri of uris) {
      try {
        const data = await vscode.workspace.fs.readFile(uri)
        const text = Buffer.from(data).toString('utf8')
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
        if (!progressShown && elapsed > 500) {
          progressShown = true
          viewerPanel!.webview.postMessage({ type: 'gts-scan-started', detail: { total } })
        }
        if (progressShown && (processed % 50 === 0 || processed === total)) {
          viewerPanel!.webview.postMessage({ type: 'gts-scan-progress', detail: { processed, total } })
        }
      }
    }

    // Prepare JsonRegistry and set default file before validation
    const registry = new JsonRegistry()
    if (selectedFilePath) {
      (registry as any).setDefaultFile?.(selectedFilePath)
    }
    await registry.ingestFiles(files, DEFAULT_GTS_CONFIG)

    // Send scan result with default file path so the webview can compute initial selection
    viewerPanel!.webview.postMessage({ type: 'gts-scan-result', detail: { files, defaultFilePath: selectedFilePath } })
    try { setLastScanFiles(files) } catch {}

    try {
      const objs = Array.from(registry.jsonObjs.values()).map(o => ({ id: o.id, listSequence: o.listSequence, filePath: o.file?.path, schemaId: o.schemaId, validation: o.validation }))
      const schemas = Array.from(registry.jsonSchemas.values()).map(s => ({ id: s.id, filePath: s.file?.path, validation: s.validation }))
      const invalidFilesHost = Array.from(registry.invalidFiles.values()).map(f => ({ path: f.path, name: f.name, validation: f.validation }))
      viewerPanel!.webview.postMessage({ type: 'gts-validation-result', detail: { objs, schemas, invalidFiles: invalidFilesHost } })
    } catch (ve: any) {
      viewerPanel!.webview.postMessage({ type: 'gts-validation-error', detail: { error: ve?.message || String(ve) } })
    }

    // After scan + validation updates are delivered, instruct the webview to refresh diagrams for the updated file
    if (refreshFilePath) {
      try {
        viewerPanel!.webview.postMessage({ type: 'gts-refresh-layout', detail: { filePath: refreshFilePath } })
      } catch {}
    }

  } catch (error: any) {
    viewerPanel!.webview.postMessage({ type: 'gts-scan-error', detail: { error: error.message || String(error) } })
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

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gts.openViewer', (resource?: vscode.Uri) => {
      openViewer(context, resource)
    })
  )

  // Show welcome message
  vscode.window.showInformationMessage('GTS Viewer is ready! Use "GTS: Open Viewer" to start.')
}

/**
 * Perform initial workspace scan to populate the registry for validation
 * This runs in the background and doesn't block extension activation
 */
async function performInitialScan() {
  try {
    const include = '**/*.{json,jsonc,gts}'
    const exclude = '**/{node_modules,.gts-viewer,dist,.git}/**'
    const uris = await vscode.workspace.findFiles(include, exclude, 10000)

    console.log(`[GTS] Found ${uris.length} JSON/JSONC/GTS files in workspace`)

    const files: Array<{ path: string; name: string; content: any }> = []

    for (const uri of uris) {
      try {
        const data = await vscode.workspace.fs.readFile(uri)
        const text = Buffer.from(data).toString('utf8')
        try {
          const content = parseJSONC(text)
          files.push({ path: uri.fsPath, name: path.basename(uri.fsPath), content })
        } catch (e) {
          // If JSONC parsing fails, store as text for later validation
          files.push({ path: uri.fsPath, name: path.basename(uri.fsPath), content: text })
        }
      } catch (e) {
        // Skip files that can't be read
        console.warn(`[GTS] Could not read file: ${uri.fsPath}`, e)
      }
    }

    console.log(`[GTS] Successfully loaded ${files.length} files for validation registry`)
    setLastScanFiles(files)

    // Also ingest into a registry to verify schemas are loading
    const registry = new JsonRegistry()
    await registry.ingestFiles(files, DEFAULT_GTS_CONFIG)
    console.log(`[GTS] Registry initialized: ${registry.jsonSchemas.size} schemas, ${registry.jsonObjs.size} objects`)

    // Notify validation system that initial scan is complete
    notifyInitialScanComplete()
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

  layoutStorage = null
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
            const include: string = message.options?.include || '**/*.{json,jsonc,gts}'
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

  viewerPanel.onDidDispose(() => {
    console.log('[GTS] Viewer panel disposed')
    viewerPanel = null
    layoutStorage = null
    hasPerformedInitialScan = false // Reset for next viewer session
  }, null, context.subscriptions)

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!viewerPanel) return
      const isJsonOrGts = isGtsCandidateFile(doc)
      if (isJsonOrGts) {
        await scanAndPost('**/*.{json,jsonc,gts}', false, doc.uri.fsPath)
      }
    })
  )

  // Debounced rescan on change to auto-refresh layout view while typing
  let changeTimer: NodeJS.Timeout | null = null
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!viewerPanel) return
      const doc = event.document
      const isJsonOrGts = isGtsCandidateFile(doc)
      if (!isJsonOrGts) return
      if (changeTimer) clearTimeout(changeTimer)
      changeTimer = setTimeout(() => {
        scanAndPost('**/*.{json,jsonc,gts}', false, doc.uri.fsPath)
      }, 500)
    })
  )
}
