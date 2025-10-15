import { ScannerCapabilities } from '../../types'

/**
 * Check if File System Access API is supported in the current browser
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' &&
         'showDirectoryPicker' in window &&
         typeof (window as any).showDirectoryPicker === 'function';
}

/**
 * Get capabilities for the current web environment
 */
export function getWebCapabilities(): ScannerCapabilities {
  const fsaSupported = isFileSystemAccessSupported()

  return {
    supportsRefresh: fsaSupported,
    supportsFileWatching: false, // Web browsers don't support native file watching
    requiresReselection: !fsaSupported // Fallback scanners need directory re-selection
  }
}

/**
 * Get a user-friendly description of current browser limitations
 */
export function getBrowserLimitationMessage(): string | null {
  if (isFileSystemAccessSupported()) {
    return null // No limitations
  }

  return "Refresh is only available in the Desktop app or in the Chrome and Edge browsers. use \"Open\" to re-select the directory after modifying files."
}
