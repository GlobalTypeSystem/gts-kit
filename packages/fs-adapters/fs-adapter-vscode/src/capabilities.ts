import { ScannerCapabilities } from '../../types'

/**
 * Get capabilities for the VSCode extension environment
 */
export function getVSCodeCapabilities(): ScannerCapabilities {
  return {
    supportsRefresh: true, // VSCode can re-read workspace files
    supportsFileWatching: true, // VSCode has excellent file watching APIs
    requiresReselection: false // VSCode works with the current workspace
  }
}

/**
 * Get a user-friendly description of VSCode capabilities
 */
export function getVSCodeLimitationMessage(): string | null {
  // VSCode has full workspace access, no limitations
  return null
}

/**
 * Check if we're running in VSCode extension environment
 */
export function isVSCodeEnvironment(): boolean {
  // Check if VSCode API is available
  try {
    return typeof require !== 'undefined' && require('vscode') !== undefined
  } catch {
    return false
  }
}
