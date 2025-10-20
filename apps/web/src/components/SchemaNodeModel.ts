import type { JsonObj, JsonSchema } from '@gts/shared'
import { SchemaEdgeModel } from './SchemaEdgeModel'
import { parseJsonToProperties, parseSchemaToProperties } from '../lib/schemaParser'
import { debug } from '@/lib/debug'
import type { Position } from '@/lib/types'
export type NodeKind = 'json' | 'schema'

export class SchemaNodeModel {
  entity: JsonObj | JsonSchema
  id: string
  position: Position
  expanded: boolean
  rawView: boolean
  sections: Record<string, boolean>
  properties?: any[]
  edges: SchemaEdgeModel[]
  isMaximized: boolean
  snapshotChecked: boolean

  // Dirtiness detection
  origExpanded: boolean
  origRawView: boolean
  origPosition: Position
  origSections: Record<string, boolean>

  constructor(params: {
    entity: JsonObj | JsonSchema
    position?: Position
    expanded?: boolean
    rawView?: boolean
    sections?: Record<string, boolean>
    isMaximized?: boolean
  }) {
    this.entity = params.entity
    this.id = params.entity.id
    this.position = params.position ? { x: params.position.x, y: params.position.y } : { x: 0, y: 0 }
    this.expanded = params.expanded ?? true
    this.rawView = params.rawView ?? false
    this.sections = params.sections || {}
    this.edges = []
    this.isMaximized = params.isMaximized ?? false
    this.snapshotChecked = false
    this.properties = params.entity.isSchema
      ? parseSchemaToProperties(params.entity.content)
      : parseJsonToProperties(params.entity.content)

    // Dirtiness calculation assistance
    this.origExpanded = params.expanded ?? true
    this.origRawView = params.rawView ?? false
    this.origPosition = params.position ? { x: params.position.x, y: params.position.y } : { x: 0, y: 0 }
    this.origSections = params.sections || {}
    debug.node("constructor node {" + this.entity.id + "} constructor", this.position.x, this.position.y, "orig:", this.origPosition.x, this.origPosition.y)
  }

  // apply layout from diagram storage
  initLayout(position: Position, expanded: boolean, rawView: boolean, sections: Record<string, boolean>) {
    // clone to avoid shared references
    this.position = { x: position.x, y: position.y }
    this.expanded = expanded
    this.rawView = rawView
    this.sections = { ...sections }
    this.snapshotChecked = true
    this.origExpanded = expanded
    this.origRawView = rawView
    this.origPosition = { x: position.x, y: position.y }
    this.origSections = { ...sections }
    debug.node("initLayout node {" + this.entity.id + "} applyLayoutFromSnapshot", position.x, position.y, "orig:", this.origPosition.x, this.origPosition.y)
  }

  // update position from diagram view
  updatePosition(position: Position) {
    debug.node("updatePosition node {" + this.entity.id + "} updatePosition", position.x, position.y, "orig:", this.origPosition.x, this.origPosition.y)
    this.position.x = position.x
    this.position.y = position.y
  }

  isDirty(): boolean {
    if (this.rawView !== this.origRawView) return true
    if (this.position.x !== this.origPosition.x || this.position.y !== this.origPosition.y) return true
    if (this.expanded !== this.origExpanded) return true

    const sectionsKeys = Object.keys(this.sections)
    const origSectionsKeys = Object.keys(this.origSections)

    if (sectionsKeys.length !== origSectionsKeys.length) return true

    // Check all keys in current sections
    for (const key of sectionsKeys) {
      if (this.sections[key] !== this.origSections[key]) return true
    }

    // Check all keys in original sections (in case some were removed)
    for (const key of origSectionsKeys) {
      if (this.sections[key] !== this.origSections[key]) return true
    }

    return false
  }

  addEdge(edge: SchemaEdgeModel) { this.edges.push(edge) }

  // Reset the baseline after a successful save
  resetDirtyBaseline() {
    this.origExpanded = this.expanded
    this.origRawView = this.rawView
    this.origPosition = { x: this.position.x, y: this.position.y }
    this.origSections = { ...this.sections }
    debug.node("resetDirtyBaseline node {" + this.entity.id + "} resetDirtyBaseline", this.origRawView, this.origPosition.x, this.origPosition.y, this.origSections)
  }

  // Build payload for saving this node
  serialize() {
    return {
      id: this.id,
      filename: this.entity?.file?.name || this.entity?.label || this.id,
      schemaId: this.entity?.schemaId || '',
      type: this.entity?.isSchema ? 'schema' as const : 'json' as const,
      position: { x: this.position.x, y: this.position.y },
      expansion: {
        expanded: this.expanded,
        sections: this.sections,
      },
      extra: { rawView: this.rawView },
    }
  }
}
