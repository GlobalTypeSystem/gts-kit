import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { ILayoutStorage, LayoutSnapshot, LayoutSaveRequest, LayoutTarget } from '@gts/layout-storage'

/**
 * Repository folder-based layout storage for VS Code version
 * Stores layouts in .gts-viewer/ directory in the repository root
 */
export class RepoLayoutStorage implements ILayoutStorage {
  private layoutsDir: string

  constructor(repoRootPath: string) {
    this.layoutsDir = join(repoRootPath, '.gts-viewer')
  }

  private async ensureLayoutsDir(): Promise<void> {
    if (!existsSync(this.layoutsDir)) {
      await mkdir(this.layoutsDir, { recursive: true })
    }
  }

  private getLayoutFilePath(target: LayoutTarget): string {
    // Create a unique filename based on target properties
    const safeName = this.sanitizeFilename(target.filename || target.id)
    const safeId = this.sanitizeFilename(target.id)
    return join(this.layoutsDir, `${safeId}_${safeName}.json`)
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  async getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null> {
    if (!target.id || !target.filename || !target.schemaId) {
      return null
    }

    await this.ensureLayoutsDir()

    const filePath = this.getLayoutFilePath(target as LayoutTarget)
    
    if (!existsSync(filePath)) {
      return null
    }

    try {
      const content = await readFile(filePath, 'utf-8')
      const snapshot = JSON.parse(content) as LayoutSnapshot
      return snapshot
    } catch (error) {
      console.error('Failed to read layout file:', error)
      return null
    }
  }

  async saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot> {
    await this.ensureLayoutsDir()

    const filePath = this.getLayoutFilePath(request.target)
    
    // Read existing version or start at 1
    let version = '1'
    let layoutId = this.generateLayoutId(request.target)

    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const existing = JSON.parse(content) as LayoutSnapshot
        version = String(parseInt(existing.version, 10) + 1)
        layoutId = existing.layoutId
      } catch (error) {
        // If we can't read existing, just use defaults
        console.warn('Could not read existing layout, creating new:', error)
      }
    }

    const snapshot: LayoutSnapshot = {
      ...request,
      layoutId,
      version,
      createdAt: new Date().toISOString(),
    }

    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
    return snapshot
  }

  private generateLayoutId(target: LayoutTarget): string {
    // Generate a deterministic ID based on target properties
    return `layout_${this.sanitizeFilename(target.id)}_${Date.now()}`
  }

  async listVersions(target: Partial<LayoutTarget>): Promise<Array<{
    layoutId: string
    version: string
    createdAt: string
  }>> {
    // File-based storage only keeps one version per file
    // Return the current version if it exists
    const snapshot = await this.getLatestLayout(target)
    if (!snapshot) return []
    
    return [{
      layoutId: snapshot.layoutId,
      version: snapshot.version,
      createdAt: snapshot.createdAt,
    }]
  }
}
