import type { ILayoutStorage, LayoutSnapshot, LayoutSaveRequest, LayoutTarget } from '@gts/layout-storage'
import { decodeGtsId } from '@gts/shared'

/**
 * Server-based layout storage for web version
 * Uses REST API endpoints to store layouts on the server
 */
export class ServerLayoutStorage implements ILayoutStorage {
  private apiBaseUrl: string
  private workspaceName: string

  constructor(apiBaseUrl: string, workspaceName: string = 'default') {
    this.apiBaseUrl = apiBaseUrl
    this.workspaceName = workspaceName
  }

  async getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null> {
    if (!target.id) {
      throw new Error('Target ID is required')
    }

    // Decode entity ID to ASCII (handles URL encoding like %7E -> ~)
    const decodedId = decodeGtsId(target.id)

    const url = new URL(this.apiBaseUrl + '/layouts')
    url.searchParams.set('workspace', this.workspaceName)
    url.searchParams.set('id', decodedId)

    const res = await fetch(url.toString())
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Failed to load layout: ${res.status}`)
    const data = await res.json()
    return data as LayoutSnapshot
  }

  async saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot> {
    // Decode entity ID to ASCII and ensure workspace is set
    const decodedId = decodeGtsId(request.target.id)

    const requestWithWorkspace = {
      ...request,
      target: {
        ...request.target,
        id: decodedId,
        workspace: this.workspaceName
      }
    }

    const res = await fetch(this.apiBaseUrl + '/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestWithWorkspace),
    })
    if (!res.ok) throw new Error(`Failed to save layout: ${res.status}`)
    const data = await res.json()
    return data as LayoutSnapshot
  }
}
