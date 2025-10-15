// Edge relationship configuration
import type { EdgeKind } from '@/components/SchemaEdgeModel'

export interface EdgeStyle {
  stroke: string
  strokeWidth: number
  strokeDasharray?: string
}

export interface EdgeConfig {
  priority: number
  style: EdgeStyle
}

export const EDGE_CONFIG: Record<EdgeKind, EdgeConfig> = {
  schema: {
    priority: 4,
    style: {
      stroke: '#10b981',
      strokeWidth: 2,
    },
  },
  ref: {
    priority: 3,
    style: {
      stroke: '#8b5cf6',
      strokeWidth: 1,
      strokeDasharray: '6 4',
    },
  },
  'gts-json': {
    priority: 2,
    style: {
      stroke: '#f59e0b',
      strokeWidth: 1,
      strokeDasharray: '6 4',
    },
  },
  gts: {
    priority: 1,
    style: {
      stroke: '#64748b',
      strokeWidth: 1,
      strokeDasharray: '6 4',
    },
  },
  other: {
    priority: 0,
    style: {
      stroke: '#9ca3af',
      strokeWidth: 1,
      strokeDasharray: '2 2',
    },
  },
}

export function getEdgePriority(kind: EdgeKind): number {
  return EDGE_CONFIG[kind].priority
}

export function getEdgeStyle(kind: EdgeKind): EdgeStyle {
  return EDGE_CONFIG[kind].style
}
