import { SchemaNodeModel } from './SchemaNodeModel'
import { debug } from '@/lib/debug'
import { handleIdToApi } from '@/lib/handleUtils'

export type EdgeKind = 'ref' | 'schema' | 'gts' | 'gts-json' | 'other'

export class SchemaEdgeModel {
  id: string
  source: SchemaNodeModel
  target: SchemaNodeModel
  kind: EdgeKind
  name?: string
  sourceHandle: string
  targetHandle: string
  // Original handles before any dragging
  origSourceHandle: string
  origTargetHandle: string
  // Label position properties
  labelPosition: number
  labelOffset: { x: number; y: number }
  // Original label position before any dragging
  origLabelPosition: number
  origLabelOffset: { x: number; y: number }

  constructor(params: {
    id: string
    source: SchemaNodeModel
    target: SchemaNodeModel
    kind: EdgeKind
    name?: string
    sourceHandle?: string
    targetHandle?: string
    labelPosition?: number
    labelOffset?: { x: number; y: number }
  }) {
    this.id = params.id
    this.source = params.source
    this.target = params.target
    this.kind = params.kind
    this.name = params.name
    this.sourceHandle = params.sourceHandle || 'right-2'
    this.targetHandle = params.targetHandle || 'left-2'
    this.labelPosition = params.labelPosition ?? 0.5
    this.labelOffset = params.labelOffset ?? { x: 0, y: 0 }

    // Original handles before any dragging
    this.origSourceHandle = params.sourceHandle || 'right-2'
    this.origTargetHandle = params.targetHandle || 'left-2'
    // Original label position before any dragging
    this.origLabelPosition = params.labelPosition ?? 0.5
    this.origLabelOffset = params.labelOffset ?? { x: 0, y: 0 }
  }

  get sourceId() { return this.source.id }
  get targetId() { return this.target.id }

  // Apply layout from diagram storage (similar to SchemaNodeModel.applyLayoutFromSnapshot)
  initHandlers(sourceHandle: string, targetHandle: string, labelPosition?: number, labelOffset?: { x: number; y: number }) {
    debug.edge("edge {" + this.id + "} applyLayoutFromSnapshot", sourceHandle, targetHandle, "orig:", this.origSourceHandle, this.origTargetHandle)
    this.sourceHandle = sourceHandle
    this.targetHandle = targetHandle
    if (labelPosition !== undefined) {
      this.labelPosition = labelPosition
    }
    if (labelOffset !== undefined) {
      this.labelOffset = { ...labelOffset }
    }
    // Update originals to mark as clean after loading from snapshot
    this.origSourceHandle = sourceHandle
    this.origTargetHandle = targetHandle
    this.origLabelPosition = this.labelPosition
    this.origLabelOffset = { ...this.labelOffset }
  }

  // Update handles from edge view (similar to SchemaNodeModel.updatePosition)
  updateHandles(sourceHandle?: string, targetHandle?: string) {
    if (sourceHandle !== undefined) {
      debug.edge("edge {" + this.id + "} updateSourceHandle", sourceHandle, "orig:", this.origSourceHandle)
      this.sourceHandle = sourceHandle
    }
    if (targetHandle !== undefined) {
      debug.edge("edge {" + this.id + "} updateTargetHandle", targetHandle, "orig:", this.origTargetHandle)
      this.targetHandle = targetHandle
    }
  }

  // Update label position from edge view
  updateLabelPosition(labelPosition?: number, labelOffset?: { x: number; y: number }) {
    if (labelPosition !== undefined) {
      debug.edge("edge {" + this.id + "} updateLabelPosition", labelPosition, "orig:", this.origLabelPosition)
      this.labelPosition = labelPosition
    }
    if (labelOffset !== undefined) {
      debug.edge("edge {" + this.id + "} updateLabelOffset", labelOffset, "orig:", this.origLabelOffset)
      this.labelOffset = { ...labelOffset }
    }
  }

  isDirty(): boolean {
    const handlesDirty = this.sourceHandle !== this.origSourceHandle || this.targetHandle !== this.origTargetHandle
    const labelPositionDirty = this.labelPosition !== this.origLabelPosition
    const labelOffsetDirty = this.labelOffset.x !== this.origLabelOffset.x || this.labelOffset.y !== this.origLabelOffset.y
    const dirty = handlesDirty || labelPositionDirty || labelOffsetDirty
    if (dirty) {
      debug.edge("edge {" + this.id + "} isDirty",
        "handles:", this.sourceHandle, "!=", this.origSourceHandle, "||", this.targetHandle, "!=", this.origTargetHandle,
        "labelPos:", this.labelPosition, "!=", this.origLabelPosition,
        "labelOffset:", this.labelOffset, "!=", this.origLabelOffset)
    }
    return dirty
  }

  // Reset the baseline after a successful save
  resetDirtyBaseline() {
    this.origSourceHandle = this.sourceHandle
    this.origTargetHandle = this.targetHandle
    this.origLabelPosition = this.labelPosition
    this.origLabelOffset = { ...this.labelOffset }
  }

  // Map edge kind to API relation type
  private mapRelation(kind: EdgeKind): 'implements'|'ref'|'gts'|'other' {
    switch (kind) {
      case 'ref': return 'ref'
      case 'gts':
      case 'gts-json': return 'gts'
      default: return 'other'
    }
  }

  // Build payload for saving this edge
  serialize() {
    return {
      id: this.id,
      source: this.sourceId,
      target: this.targetId,
      relation: this.mapRelation(this.kind),
      sourceKey: this.name || '',
      handles: {
        source: handleIdToApi(this.sourceHandle),
        target: handleIdToApi(this.targetHandle),
      },
      labelPosition: this.labelPosition,
      labelOffset: this.labelOffset
    }
  }
}
