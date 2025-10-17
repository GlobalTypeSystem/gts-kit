import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import isDev from 'electron-is-dev'
import { startServer, type ServerInstance } from '@gts/server'

app.disableHardwareAcceleration()

// Disable macOS AI features that cause crashes on macOS 15.5
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor,WritingTools,GenerativeModels')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let serverInstance: ServerInstance | null = null

async function createWindow() {
  // Start the server with a database in userData
  const dbPath = path.join(app.getPath('userData'), 'viewer.db')
  console.log('[Electron] Starting server with database:', dbPath)

  try {
    serverInstance = await startServer({
      port: 7806,
      dbFile: dbPath,
      allowAnonymous: true
    })
    console.log('[Electron] Server started on port:', serverInstance.port)
  } catch (err) {
    console.error('[Electron] Failed to start server:', err)
    app.quit()
    return
  }

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !isDev
    },
    title: 'GTS Viewer'
  })

  // Load the app
  const webDistPath = path.join(__dirname, '../../web/dist/index.html')
  console.log('[Electron] Loading built app:', webDistPath)
  await mainWindow.loadFile(webDistPath)
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', async () => {
  // Stop the server
  if (serverInstance) {
    console.log('[Electron] Stopping server...')
    await serverInstance.stop()
  }

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})

// Handle app quit
app.on('before-quit', async (event) => {
  if (serverInstance) {
    event.preventDefault()
    console.log('[Electron] Cleaning up...')
    await serverInstance.stop()
    serverInstance = null
    app.quit()
  }
})
