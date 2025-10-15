// Handle conversion utilities
import type { HandlePosition } from './types'

type HandleId = string

// Bidirectional mapping between handle IDs and API handle positions
// Internal format: 'left-1', 'left-2', 'left-3' where 1,2,3 are position indices
// API format: {side: 'Left', pct: 0.25/0.5/0.75} where pct is decimal percentage (0.25 = 25%)
const HANDLE_MAP: Record<HandleId, HandlePosition> = {
  'left-1': { side: 'Left', pct: 0.25 },
  'left-2': { side: 'Left', pct: 0.5 },
  'left-3': { side: 'Left', pct: 0.75 },
  'right-1': { side: 'Right', pct: 0.25 },
  'right-2': { side: 'Right', pct: 0.5 },
  'right-3': { side: 'Right', pct: 0.75 },
  'top-1': { side: 'Top', pct: 0.25 },
  'top-2': { side: 'Top', pct: 0.5 },
  'top-3': { side: 'Top', pct: 0.75 },
  'bottom-1': { side: 'Bottom', pct: 0.25 },
  'bottom-2': { side: 'Bottom', pct: 0.5 },
  'bottom-3': { side: 'Bottom', pct: 0.75 },
}

// Reverse mapping for fast lookup
const API_TO_ID = Object.fromEntries(
  Object.entries(HANDLE_MAP).map(([id, pos]) => [`${pos.side}-${pos.pct}`, id])
)

/**
 * Convert handle id like 'right-2' to API HandlePosition
 */
export function handleIdToApi(handleId?: string | null): HandlePosition | undefined {
  if (!handleId) return undefined
  return HANDLE_MAP[handleId]
}

/**
 * Convert API HandlePosition to handle id string
 */
export function apiHandleToId(handle?: HandlePosition | null): string | undefined {
  if (!handle) return undefined
  return API_TO_ID[`${handle.side}-${handle.pct}`]
}
