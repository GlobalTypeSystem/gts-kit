import type {
  LayoutTarget,
  LayoutNode,
  LayoutEdge,
  CanvasState,
  LayoutSaveRequest,
  LayoutSnapshot,
  ILayoutStorage
} from '@gts/layout-storage'
import { AppConfig } from '@/lib/config'
import { ServerLayoutStorage } from './storage'

import type { AppApi } from '@/utils/appApi'

// Re-export types for backward compatibility
export type ApiLayoutTarget = LayoutTarget
export type ApiLayoutNode = LayoutNode
export type ApiLayoutEdge = LayoutEdge
export type ApiCanvasState = CanvasState
export type ApiLayoutSaveRequest = LayoutSaveRequest
export type ApiLayoutSnapshot = LayoutSnapshot

/**
 * Get the injected App API (provided by platform: electron, vscode, or web)
 */
export function getAppApi(): AppApi {
  if (typeof window !== 'undefined' && window.__GTS_APP_API__) {
    return window.__GTS_APP_API__
  }

  // Default to web if no API was injected
  return { type: 'web' }
}

// Platform-injected storage adapter - wraps external provider to match ILayoutStorage interface
class PlatformLayoutStorage implements ILayoutStorage {
  private provider: NonNullable<AppApi['layoutStorage']>

  constructor(provider: NonNullable<AppApi['layoutStorage']>) {
    this.provider = provider
  }

  async getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null> {
    return this.provider.getLatestLayout(target)
  }

  async saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot> {
    return this.provider.saveLayout(request)
  }
}

// Build API base URL from config (treat empty hostname as localhost)
function getApiBaseUrl(): string {
  // Check env override first
  const envBase = (import.meta as any).env?.GTS_SERVER_API_BASE as string
  if (envBase) return envBase

  // Use config
  const config = AppConfig.get()
  const hostname = config.server.hostname || 'localhost'
  const port = config.server.port || 7080
  return `http://${hostname}:${port}`
}

let storageInstance: ILayoutStorage | null = null

export function getLayoutStorage(): ILayoutStorage {
  if (!storageInstance) {
    const appApi = getAppApi()

    // Check if a storage provider was injected by the platform
    if (appApi.layoutStorage) {
      console.log(`[Layout Storage] Using platform storage (${appApi.type})`)
      storageInstance = new PlatformLayoutStorage(appApi.layoutStorage)
    } else {
      console.log('[Layout Storage] Using Server storage')
      const config = AppConfig.get()
      const workspace = config.workspace || 'default'
      storageInstance = new ServerLayoutStorage(getApiBaseUrl(), workspace)
    }
  }
  return storageInstance
}

// Expose API base URL for error messages
export function getApiBase(): string {
  return getApiBaseUrl()
}

// Legacy API functions for backward compatibility
export async function getLatestLayout(params: Partial<ApiLayoutTarget> & { id?: string; filename?: string; schemaId?: string }): Promise<ApiLayoutSnapshot | null> {
  return getLayoutStorage().getLatestLayout(params)
}

export async function saveLayout(payload: ApiLayoutSaveRequest): Promise<ApiLayoutSnapshot> {
  return getLayoutStorage().saveLayout(payload)
}
