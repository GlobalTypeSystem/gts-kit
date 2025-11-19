import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { HomeFolderLayoutStorage } from './storage'
import type { LayoutSaveRequest, LayoutTarget } from '@gts/layout-storage'

let mainWindow: BrowserWindow
let layoutStorage: HomeFolderLayoutStorage

// Lazy-load ESM module from CJS using dynamic import
let parseJSONCFn: ((s: string) => any) | null = null
let parseYAMLFn: ((s: string) => any) | null = null
async function ensureSharedLoaded() {
  if (!parseJSONCFn) {
    const mod: any = await import('@gts-viewer/shared')
    parseJSONCFn = mod.parseJSONC
    parseYAMLFn = mod.parseYAML
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    height: 900,
    width: 1200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'default',
    title: 'GTS Viewer',
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3001')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadURL('app://./index.html')
  }
}

app.whenReady().then(() => {
  // Register custom protocol for loading local files with proper MIME types
  protocol.registerFileProtocol('app', (request, callback) => {
    const url = request.url.substring('app://'.length)
    const filePath = path.normalize(path.join(__dirname, '../renderer', url))
    callback({ path: filePath })
  })

  // Initialize layout storage
  layoutStorage = new HomeFolderLayoutStorage()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC handlers for file system operations
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select directory containing JSON files',
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
})

ipcMain.handle('read-directory', async (_, directoryPath: string) => {
  try {
    const files: Array<{ path: string; name: string; content: any; isSchema: boolean }> = []
    await ensureSharedLoaded()

    async function readDirectory(dirPath: string) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          await readDirectory(fullPath)
        } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonc') || entry.name.endsWith('.gts') || entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8')
            const isYaml = entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')
            const jsonContent = isYaml ? parseYAMLFn!(content) : parseJSONCFn!(content)
            const relativePath = path.relative(directoryPath, fullPath)
            const isSchema = entry.name.includes('schema') ||
                           jsonContent.$schema ||
                           jsonContent.$id

            files.push({
              path: relativePath,
              name: entry.name,
              content: jsonContent,
              isSchema
            })
          } catch (error) {
            console.warn(`Failed to read JSON file ${fullPath}:`, error)
          }
        }
      }
    }

    await readDirectory(directoryPath)
    return files
  } catch (error) {
    throw new Error(`Failed to read directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
})

ipcMain.handle('save-layout', async (_, request: LayoutSaveRequest) => {
  try {
    const snapshot = await layoutStorage.saveLayout(request)
    console.log('[Electron] Layout saved:', snapshot.layoutId)
    return snapshot
  } catch (error) {
    console.error('[Electron] Failed to save layout:', error)
    throw error
  }
})

ipcMain.handle('get-latest-layout', async (_, target: Partial<LayoutTarget>) => {
  try {
    const snapshot = await layoutStorage.getLatestLayout(target)
    console.log('[Electron] Layout loaded for:', target.id, snapshot ? 'found' : 'not found')
    return snapshot
  } catch (error) {
    console.error('[Electron] Failed to load layout:', error)
    throw error
  }
})
