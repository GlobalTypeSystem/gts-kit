import { ScannerCapabilities } from '../../types'

/**
 * Get capabilities for the Electron environment
 */
export function getElectronCapabilities(): ScannerCapabilities {
  return {
    supportsRefresh: true, // Electron can re-read files from disk
    supportsFileWatching: false, // Not implemented yet, but could be added with chokidar
    requiresReselection: false // Electron maintains directory access
  }
}

/**
 * Get a user-friendly description of Electron capabilities
 */
export function getElectronLimitationMessage(): string | null {
  // Electron has full file system access, no limitations
  return null
}

/**
 * Check if we're running in Electron environment
 */
export function isElectronEnvironment(): boolean {
  return typeof window !== 'undefined' &&
         window.electronAPI !== undefined &&
         typeof window.electronAPI.selectDirectory === 'function'
}
