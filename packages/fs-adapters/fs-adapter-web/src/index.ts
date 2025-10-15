import { Scanner, ScanOptions, JsonDoc, FileChange, CapabilityProvider, ScannerCapabilities } from '../../types'
import { WebFsaScanner } from './fsa'
import { WebFallbackScanner } from './fallback'
import { isFileSystemAccessSupported, getWebCapabilities } from './capabilities'

/**
 * Smart scanner that automatically chooses between File System Access API
 * and fallback file input based on browser support
 */
export class WebSmartScanner implements Scanner, CapabilityProvider {
  private scanner: Scanner

  constructor() {
    // Choose the appropriate scanner based on browser support
    if (isFileSystemAccessSupported()) {
      console.log('[WebSmartScanner] Using File System Access API')
      this.scanner = new WebFsaScanner()
    } else {
      console.log('[WebSmartScanner] Using fallback file input (File System Access API not supported)')
      this.scanner = new WebFallbackScanner()
    }
  }

  async requestDirectoryAccess(): Promise<void> {
    return this.scanner.requestDirectoryAccess()
  }

  async list(opts?: ScanOptions): Promise<JsonDoc[]> {
    return this.scanner.list(opts)
  }

  async read(path: string): Promise<string> {
    return this.scanner.read(path)
  }

  watch(opts: ScanOptions, onChange: (ev: FileChange) => void): () => void {
    return this.scanner.watch(opts, onChange)
  }

  /**
   * Get information about the current scanner implementation
   */
  getImplementation(): 'fsa' | 'fallback' {
    return this.scanner instanceof WebFsaScanner ? 'fsa' : 'fallback'
  }

  /**
   * Get capabilities for the current web environment
   */
  getCapabilities(): ScannerCapabilities {
    return getWebCapabilities()
  }

  /**
   * Check if the current browser supports File System Access API
   * @deprecated Use getCapabilities().supportsRefresh instead
   */
  static isFileSystemAccessSupported(): boolean {
    return isFileSystemAccessSupported()
  }
}

// Export capability functions for direct use
export { isFileSystemAccessSupported, getWebCapabilities, getBrowserLimitationMessage } from './capabilities'
