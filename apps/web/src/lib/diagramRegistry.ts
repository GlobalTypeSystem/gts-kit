// Central registry for diagram instances and global view state
import type { DiagramModel } from '@/components/DiagramModel'

export type GlobalViewState = {
  hasAnyMaximizedEntity: boolean
  globalRawViewPreference: boolean
}

class DiagramRegistry {
  private diagrams = new Map<string, DiagramModel>()
  private viewState: GlobalViewState = {
    hasAnyMaximizedEntity: false,
    globalRawViewPreference: false,
  }

  get(id: string): DiagramModel | undefined {
    return this.diagrams.get(id)
  }

  set(id: string, diagram: DiagramModel): void {
    this.diagrams.set(id, diagram)
  }

  has(id: string): boolean {
    return this.diagrams.has(id)
  }

  delete(id: string): boolean {
    return this.diagrams.delete(id)
  }

  clear(): void {
    this.diagrams.clear()
  }

  getViewState(): GlobalViewState {
    return this.viewState
  }

  setMaximized(value: boolean): void {
    this.viewState.hasAnyMaximizedEntity = value
  }

  setRawViewPreference(value: boolean): void {
    this.viewState.globalRawViewPreference = value
  }

  size(): number {
    return this.diagrams.size
  }
}

// Singleton instance
export const diagramRegistry = new DiagramRegistry()

// Make it accessible globally for debugging and cache clearing
;(globalThis as any).__GTS_VIEWER_DIAGRAM_REGISTRY__ = diagramRegistry
