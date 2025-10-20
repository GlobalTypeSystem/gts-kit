import { GTS_REGEX } from './entities.js'

/**
 * Parse a GTS ID string and extract its parts
 * For example: "gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~"
 * Returns:
 * - Part 1: "gts.x.core.events.type.v1~" (schema type)
 * - Part 2: "x.commerce.orders.order_placed.v1.0~" (instance, if exists)
 */
export function parseGtsIdParts(gtsId: string): string[] {
  const parts: string[] = []

  // Find the first tilde
  const firstTildeIndex = gtsId.indexOf('~')
  if (firstTildeIndex === -1) {
    // No tilde found, return the whole ID
    return [gtsId]
  }

  // First part: from start to first tilde (inclusive)
  const firstPart = gtsId.substring(0, firstTildeIndex + 1)
  parts.push(firstPart)

  // Check if there's a second part after the first tilde
  const remainingPart = gtsId.substring(firstTildeIndex + 1)
  if (remainingPart.length > 0) {
    // Second part exists
    parts.push(remainingPart)
  }

  return parts
}

/**
 * Represents a styled segment of a GTS ID
 */
export interface GtsStyledSegment {
  /** The text content of this segment */
  text: string
  /** The type of entity this segment represents */
  type: 'schema' | 'instance' | 'error' | 'invalid'
  /** The full entity ID to look up (for schema or instance) */
  entityId: string
  /** Start offset within the full GTS ID string */
  startOffset: number
  /** End offset within the full GTS ID string */
  endOffset: number
}

/**
 * Result of analyzing a GTS ID for styling
 */
export interface GtsStyleAnalysis {
  /** Whether the GTS ID matches the valid format */
  isValid: boolean
  /** Styled segments of the GTS ID */
  segments: GtsStyledSegment[]
  /** The original GTS ID */
  originalId: string
}

/**
 * Analyze a GTS ID and determine how each part should be styled
 * 
 * @param gtsId - The GTS ID to analyze
 * @param entityLookup - Function to look up whether an entity exists and its type
 * @returns Analysis result with styled segments
 * 
 * @example
 * ```typescript
 * const analysis = analyzeGtsIdForStyling(
 *   'gts.x.core.events.topic.v1~x.core.idp.contacts.v2',
 *   (id) => {
 *     const entity = registry.get(id)
 *     return entity ? { exists: true, isSchema: entity.isSchema } : { exists: false }
 *   }
 * )
 * ```
 */
export function analyzeGtsIdForStyling(
  gtsId: string,
  entityLookup: (entityId: string) => { exists: boolean; isSchema?: boolean }
): GtsStyleAnalysis {
  const isValid = GTS_REGEX.test(gtsId)
  const segments: GtsStyledSegment[] = []

  // If invalid format, return single error segment
  if (!isValid) {
    segments.push({
      text: gtsId,
      type: 'invalid',
      entityId: gtsId,
      startOffset: 0,
      endOffset: gtsId.length
    })
    return { isValid: false, segments, originalId: gtsId }
  }

  // Parse the GTS ID into parts
  const parts = parseGtsIdParts(gtsId)

  let currentOffset = 0
  for (const part of parts) {
    // Determine the full entity ID to look up
    let entityIdToLookup: string
    if (parts.length === 1) {
      entityIdToLookup = part
    } else if (part === parts[0]) {
      entityIdToLookup = part
    } else {
      entityIdToLookup = parts[0] + part
    }

    // Look up the entity
    const lookupResult = entityLookup(entityIdToLookup)

    let segmentType: 'schema' | 'instance' | 'error'
    if (lookupResult.exists) {
      segmentType = lookupResult.isSchema ? 'schema' : 'instance'
    } else {
      segmentType = 'error'
    }

    segments.push({
      text: part,
      type: segmentType,
      entityId: entityIdToLookup,
      startOffset: currentOffset,
      endOffset: currentOffset + part.length
    })

    currentOffset += part.length
  }

  return { isValid: true, segments, originalId: gtsId }
}

/**
 * Extract GTS IDs from a JSON string
 * This finds all string values that start with "gts."
 * 
 * @param jsonText - The JSON text to search
 * @returns Array of objects containing the GTS ID and its position
 */
export function extractGtsIdsFromJson(jsonText: string): Array<{ id: string; start: number; end: number }> {
  const results: Array<{ id: string; start: number; end: number }> = []
  
  // Match string values that contain GTS IDs
  // This regex looks for quoted strings that start with "gts."
  const stringPattern = /"(gts\.[^"]+)"/g
  
  let match: RegExpExecArray | null
  while ((match = stringPattern.exec(jsonText)) !== null) {
    const gtsId = match[1]
    // The start position is after the opening quote
    const start = match.index + 1
    const end = start + gtsId.length
    
    results.push({ id: gtsId, start, end })
  }
  
  return results
}
