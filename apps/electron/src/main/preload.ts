import { contextBridge, ipcRenderer } from 'electron'

// Minimal local copy of AppApi type to avoid importing from web package
type AppType = 'web' | 'electron' | 'vscode'
type FileInfo = { path: string; name: string; content: any; isSchema: boolean }
type LayoutTarget = { id: string; filename: string; schemaId: string; workspaceName?: string | null }
type LayoutSnapshot = { layoutId: string; version: string; createdAt: string; target: LayoutTarget; canvas: any; nodes: any[]; edges: any[]; meta?: Record<string, unknown> }
type LayoutSaveRequest = { target: LayoutTarget; canvas: any; nodes: any[]; edges: any[]; meta?: Record<string, unknown> }
type FileSystemApi = { selectDirectory(): Promise<string | null>; readDirectory(path: string): Promise<FileInfo[]> }
type LayoutStorageApi = { getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null>; saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot> }
type AppApi = { type: AppType; fileSystem?: FileSystemApi; layoutStorage?: LayoutStorageApi }

/**
 * Unified App API for Electron
 * Provides file system access and layout storage via IPC
 */
const appApi: AppApi = {
  type: 'electron',

  fileSystem: {
    async selectDirectory(): Promise<string | null> {
      return ipcRenderer.invoke('select-directory')
    },

    async readDirectory(path: string) {
      return ipcRenderer.invoke('read-directory', path)
    }
  },

  layoutStorage: {
    async getLatestLayout(target: any): Promise<any> {
      return ipcRenderer.invoke('get-latest-layout', target)
    },

    async saveLayout(request: any): Promise<any> {
      return ipcRenderer.invoke('save-layout', request)
    }
  }
}

// Expose unified API to renderer process
contextBridge.exposeInMainWorld('__GTS_APP_API__', appApi)
