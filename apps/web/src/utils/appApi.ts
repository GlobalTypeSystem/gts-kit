/**
 * Unified application API interface
 * Provides platform-agnostic access to platform-specific features
 */

export type AppType = 'web' | 'electron' | 'vscode'

export interface FileInfo {
  path: string
  name: string
  content: any
  isSchema: boolean
}

export interface LayoutTarget {
  workspaceName?: string | null
  id: string
  filename: string
  schemaId: string
}

export interface LayoutSnapshot {
  layoutId: string
  version: string
  createdAt: string
  target: LayoutTarget
  canvas: any
  nodes: any[]
  edges: any[]
  meta?: Record<string, unknown>
}

export interface LayoutSaveRequest {
  target: LayoutTarget
  canvas: any
  nodes: any[]
  edges: any[]
  meta?: Record<string, unknown>
}

/**
 * File system operations for platforms that support direct file access
 */
export interface FileSystemApi {
  selectDirectory(): Promise<string | null>
  readDirectory(path: string): Promise<FileInfo[]>
}

/**
 * Layout storage for platforms that don't use the HTTP server
 */
export interface LayoutStorageApi {
  getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null>
  saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot>
}

/**
 * Main application API - injected by each platform
 */
export interface AppApi {
  /** Platform type */
  readonly type: AppType

  /** File system access (available on electron, vscode) */
  readonly fileSystem?: FileSystemApi

  /** Layout storage (available on electron; vscode uses server) */
  readonly layoutStorage?: LayoutStorageApi
}

/**
 * Global window augmentation
 */
declare global {
  interface Window {
    __GTS_APP_API__?: AppApi
  }
}
