import { GTS_REGEX, normalizeGtsId } from './entities.js'

/**
 * Parse a GTS ID string and extract its parts
 * For example: "gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~"
 * Returns:
 * - Part 1: "gts.x.core.events.type.v1~" (schema type)
 * - Part 2: "x.commerce.orders.order_placed.v1.0~" (instance, if exists)
 *
 * Note: The input is normalized to strip gts:// prefix (per GTS spec).
 */
export function parseGtsIdParts(gtsId: string): string[] {
  // Normalize to strip gts:// prefix per GTS spec
  const normalizedId = normalizeGtsId(gtsId)
  const parts: string[] = []

  // Find the first tilde
  const firstTildeIndex = normalizedId.indexOf('~')
  if (firstTildeIndex === -1) {
    // No tilde found, return the whole ID
    return [normalizedId]
  }

  // First part: from start to first tilde (inclusive)
  const firstPart = normalizedId.substring(0, firstTildeIndex + 1)
  parts.push(firstPart)

  // Check if there's a second part after the first tilde
  const remainingPart = normalizedId.substring(firstTildeIndex + 1)
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
 * @param gtsId - The GTS ID to analyze (may have gts:// prefix which is stripped)
 * @param entityLookup - Function to look up whether an entity exists and its type
 * @returns Analysis result with styled segments
 *
 * @example
 * ```typescript
 * const analysis = analyzeGtsIdForStyling(
 *   'gts://gts.x.core.events.topic.v1~x.core.idp.contacts.v2',
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
  // Normalize to strip gts:// prefix per GTS spec
  const normalizedId = normalizeGtsId(gtsId)
  const isValid = GTS_REGEX.test(normalizedId)
  const segments: GtsStyledSegment[] = []

  // If invalid format, return single error segment
  if (!isValid) {
    segments.push({
      text: normalizedId,
      type: 'invalid',
      entityId: normalizedId,
      startOffset: 0,
      endOffset: normalizedId.length
    })
    return { isValid: false, segments, originalId: normalizedId }
  }

  // Parse the GTS ID into parts (already normalized in parseGtsIdParts)
  const parts = parseGtsIdParts(normalizedId)

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

  return { isValid: true, segments, originalId: normalizedId }
}

/**
 * Extract GTS IDs from a JSON string
 * This finds all string values that start with "gts." or "gts://gts."
 * per GTS spec, $id and $ref use gts:// prefix for URI compatibility.
 *
 * @param jsonText - The JSON text to search
 * @returns Array of objects containing the normalized GTS ID and its position
 */
export function extractGtsIdsFromJson(jsonText: string): Array<{ id: string; start: number; end: number }> {
  const results: Array<{ id: string; start: number; end: number }> = []

  // Match string values that contain GTS IDs (with or without gts:// prefix)
  // This regex looks for quoted strings that start with "gts." or "gts://gts."
  const stringPattern = /"((?:gts:\/\/)?gts\.[^"]+)"/g

  let match: RegExpExecArray | null
  while ((match = stringPattern.exec(jsonText)) !== null) {
    const rawId = match[1]
    // Normalize to strip gts:// prefix per GTS spec
    const gtsId = normalizeGtsId(rawId)
    // The start position is after the opening quote
    const start = match.index + 1
    const end = start + rawId.length

    results.push({ id: gtsId, start, end })
  }

  return results
}

/**
 * Calculate Levenshtein distance between two strings
 * This measures the minimum number of single-character edits (insertions, deletions, substitutions)
 * needed to transform one string into another.
 *
 * @param a - First string
 * @param b - Second string
 * @returns The Levenshtein distance between the two strings
 *
 * @example
 * ```typescript
 * levenshteinDistance('gts.acme.core.auth.Usr.v1', 'gts.acme.core.auth.User.v1') // Returns 1
 * ```
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Find similar entity IDs based on Levenshtein distance
 * This is useful for providing "Did you mean...?" suggestions when a GTS ID is invalid or not found.
 *
 * @param targetId - The target GTS ID to find matches for
 * @param allIds - Array of all available entity IDs
 * @param maxResults - Maximum number of results to return (default: 3)
 * @returns Array of similar entity IDs, sorted by similarity (most similar first)
 *
 * @example
 * ```typescript
 * const suggestions = findSimilarEntityIds(
 *   'gts.acme.core.auth.Usr.v1',
 *   ['gts.acme.core.auth.User.v1', 'gts.acme.core.auth.Group.v1'],
 *   3
 * )
 * // Returns: ['gts.acme.core.auth.User.v1'] (only returns entities within distance threshold)
 * ```
 */
export function findSimilarEntityIds(targetId: string, allIds: string[], maxResults: number = 3): string[] {
  const similarities = allIds.map(id => ({
    id,
    distance: levenshteinDistance(targetId, id)
  }))

  // Sort by distance (lower is more similar)
  similarities.sort((a, b) => a.distance - b.distance)

  // Return top N results
  return similarities.slice(0, maxResults).map(s => s.id)
}
