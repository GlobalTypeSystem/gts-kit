import { isGtsId, isGtsType, normalizeGtsId } from './entities.js'

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

  let segmentStart = 0
  let separatorIndex = normalizedId.indexOf('~')

  while (separatorIndex !== -1) {
    parts.push(normalizedId.substring(segmentStart, separatorIndex + 1))
    segmentStart = separatorIndex + 1
    separatorIndex = normalizedId.indexOf('~', segmentStart)
  }

  if (segmentStart < normalizedId.length) {
    parts.push(normalizedId.substring(segmentStart))
  }

  return parts.length > 0 ? parts : [normalizedId]
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
 * Analyze a GTS ID and determine how each part should be styled.
 *
 * Schema-vs-instance classification is derived STRUCTURALLY from the GTS ID via
 * gts-ts (`isGtsType`). Correctness (blue/green vs red) is derived from the
 * authoritative gts-ts validation results surfaced through `entityLookup`:
 * a segment whose cumulative entity failed gts-ts validation (`isValid: false`)
 * is rendered as an error. GTS *rule* violations (abstract instantiation,
 * derivation incompatibility, x-gts-ref, ...) are therefore not re-derived here;
 * they are read back from `entityLookup`/the caller's validation errors, keeping
 * gts-ts the single source of truth.
 *
 * @param gtsId - The GTS ID to analyze (may have gts:// prefix which is stripped)
 * @param entityLookup - Function to look up whether an entity exists, its kind,
 *   and whether gts-ts validation found it valid
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
  entityLookup: (entityId: string) => { exists: boolean; isSchema?: boolean; isValid?: boolean }
): GtsStyleAnalysis {
  // Normalize to strip gts:// prefix per GTS spec
  const normalizedId = normalizeGtsId(gtsId)
  const isValid = isGtsId(normalizedId)
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
  let hasMissingAncestor = false
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex]
    const entityIdToLookup = parts.slice(0, partIndex + 1).join('')

    // A cumulative id ending in "~" names a TYPE (schema); otherwise it names
    // an INSTANCE. This shape is derived structurally from the GTS ID itself.
    const structuralIsType = isGtsType(entityIdToLookup)

    // Existence + validity lookup (skipped once an ancestor is already
    // missing/invalid, so the error cascades to the rest of the chain).
    const lookupResult = hasMissingAncestor ? { exists: false } : entityLookup(entityIdToLookup)

    let segmentType: 'schema' | 'instance' | 'error'
    if (!lookupResult.exists || lookupResult.isValid === false) {
      // Missing entity, or an entity gts-ts validation rejected → error.
      segmentType = 'error'
      hasMissingAncestor = true
    } else if (structuralIsType) {
      // A "~"-terminated (type) segment is valid only when a *schema* with that
      // id actually exists. A type-shaped id backed only by an instance document
      // (or nothing) is an error — e.g. an instance whose own id ends in "~"
      // has no backing schema.
      if (lookupResult.isSchema === true) {
        segmentType = 'schema'
      } else {
        segmentType = 'error'
        hasMissingAncestor = true
      }
    } else if (lookupResult.isSchema === true) {
      // Instance-shaped id backed by a schema document → malformed.
      segmentType = 'error'
    } else {
      segmentType = 'instance'
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

  // Match string values that contain GTS IDs (with or without gts:// prefix).
  // This regex looks for quoted strings that start with "gts." or "gts://".
  // The gts:// branch intentionally matches any body (not just gts.) so that
  // malformed identifiers like "gts://gtx.foo.bar.v1~" are surfaced for
  // validation rather than silently ignored.
  const stringPattern = /"(gts:\/\/[^"]+|gts\.[^"]+)"/g

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
