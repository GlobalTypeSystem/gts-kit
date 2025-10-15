
// Purpose: implement Scanner using platform API for filesystem access
import { Scanner, ScanOptions, JsonDoc, FileChange, CapabilityProvider, ScannerCapabilities } from "../../types";
import { getElectronCapabilities } from './capabilities';

/**
 * Get the app API - assumes it's available (injected by Electron)
 */
function getAppApi() {
  if (!window.__GTS_APP_API__) {
    throw new Error('App API not available')
  }
  if (!window.__GTS_APP_API__.fileSystem) {
    throw new Error('File system API not available on this platform')
  }
  return window.__GTS_APP_API__
}

export class ElectronScanner implements Scanner, CapabilityProvider {
  private rootPath?: string
  private cachedDocs: JsonDoc[] = []

  async requestDirectoryAccess(): Promise<void> {
    const appApi = getAppApi()
    const selectedPath = await appApi.fileSystem!.selectDirectory()
    if (!selectedPath) {
      throw new Error("No directory selected")
    }
    this.rootPath = selectedPath
  }

  async list(opts: ScanOptions = {}): Promise<JsonDoc[]> {
    if (!this.rootPath) {
      throw new Error("No directory selected")
    }

    try {
      const appApi = getAppApi()
      const files = await appApi.fileSystem!.readDirectory(this.rootPath)
      this.cachedDocs = files.map(file => ({
        path: file.path,
        name: file.name,
        mtimeMs: Date.now(), // Electron main process should provide this
        size: JSON.stringify(file.content).length
      }))
      return this.cachedDocs
    } catch (error) {
      throw new Error(`Failed to list files: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async read(path: string): Promise<string> {
    if (!this.rootPath) {
      throw new Error("No directory selected")
    }

    try {
      const appApi = getAppApi()
      // For now, re-read the directory to get the content
      // In a more optimized version, we could cache the content from list()
      const files = await appApi.fileSystem!.readDirectory(this.rootPath)
      const file = files.find(f => f.path === path)
      if (!file) {
        throw new Error(`File not found: ${path}`)
      }
      return JSON.stringify(file.content, null, 2)
    } catch (error) {
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  watch(_opts: ScanOptions, _cb: (ev: FileChange) => void): () => void {
    // File watching not implemented for Electron yet
    // Could be implemented using chokidar in the main process
    return () => {
      // no-op
    }
  }

  /**
   * Get capabilities for the Electron environment
   */
  getCapabilities(): ScannerCapabilities {
    return getElectronCapabilities()
  }
}

// Export capability functions for direct use
export { getElectronCapabilities, getElectronLimitationMessage, isElectronEnvironment } from './capabilities'
