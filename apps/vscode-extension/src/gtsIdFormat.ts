import { GTS_URI_PREFIX, normalizeGtsId, isGtsId, isGtsPattern, checkGtsUriPrefix } from '@gts/shared'

/** A string value that looks like a GTS id (starts with "gts." or "gts://") but isn't one. */
export interface MalformedGtsId {
  /** The raw value as written (possibly with a gts:// prefix). */
  value: string
  /** JSON-pointer-style path to the value, e.g. "/0/payload/type". */
  instancePath: string
}

export const GTS_ID_FORMAT_HINT =
  'gts.<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>[.<MIN>[~...]]'

export function malformedGtsIdMessage(value: string): string {
  return `Invalid GTS ID format: "${value}". Expected pattern: ${GTS_ID_FORMAT_HINT}`
}

/**
 * Find malformed GTS ids in parsed file content (JSON/JSONC/YAML object model).
 *
 * Same rules the editor's link provider applies to a live buffer: every string
 * value starting with "gts." or "gts://" must be a valid GTS id or wildcard
 * pattern. Values with a gts:// prefix problem are skipped — the validator
 * reports those itself (keyword 'gts-uri-prefix'). Computing this from content
 * rather than from an open editor is what lets closed files carry the error.
 */
export function findMalformedGtsIds(content: unknown): MalformedGtsId[] {
  const out: MalformedGtsId[] = []
  const walk = (node: unknown, segments: Array<string | number>, fieldName: string) => {
    if (typeof node === 'string') {
      if (!node.startsWith('gts.') && !node.startsWith(GTS_URI_PREFIX)) return
      if (checkGtsUriPrefix(fieldName, node)) return
      const id = normalizeGtsId(node)
      if (isGtsId(id) || isGtsPattern(id)) return
      out.push({ value: node, instancePath: segments.length ? '/' + segments.join('/') : '' })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...segments, i], fieldName))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...segments, key], key)
    }
  }
  walk(content, [], '')
  return out
}
