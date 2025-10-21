// Layout types - will be replaced by @gts/layout-storage in the future
export interface LayoutTarget {
  workspaceName?: string | null
  id: string
  filename: string
  schemaId: string
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface HandlePosition {
  side: 'Left' | 'Right' | 'Top' | 'Bottom'
  pct: number
}

export interface Handles {
  source?: HandlePosition
  target?: HandlePosition
}

export interface ExpansionState {
  expanded?: boolean
  sections?: Record<string, boolean>
}

export interface LayoutNode {
  id: string
  filename: string
  schemaId: string
  type: 'json' | 'schema' | 'virtual'
  position: Point
  size?: Size
  expansion: ExpansionState
  extra?: Record<string, unknown>
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  relation: 'implements' | 'ref' | 'gts' | 'other'
  sourceKey: string
  handles?: Handles
  labelPosition?: number
  labelOffset?: Point
}

export interface CanvasState {
  scale: number
  pan: Point
  viewportSize?: Size
}

export interface LayoutSaveRequest {
  target: LayoutTarget
  canvas: CanvasState
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  meta?: Record<string, unknown>
}

export interface LayoutSnapshot extends LayoutSaveRequest {
  layoutId: string
  version: string
  createdAt: string
}

// Global settings
export interface GlobalSettings {
  db?: {
    dialect: 'sqlite' | 'postgres'
    sqlite?: { filename: string }
    postgres?: { connectionString: string }
  }
  features?: {
    enableVersioning?: boolean
    enableImportExport?: boolean
    allowAnonymous?: boolean
  }
}

// Validation issue types for code highlighting
export type ValidationIssueType = 'offset' | 'line'

export interface ValidationIssue {
  type: ValidationIssueType
  message: string
  keyword?: string
}

export interface OffsetValidationIssue extends ValidationIssue {
  type: 'offset'
  start: number
  end: number
}

export interface LineValidationIssue extends ValidationIssue {
  type: 'line'
  lineStart: number
  lineEnd: number
}

export type ValidationIssues = Array<OffsetValidationIssue | LineValidationIssue>
