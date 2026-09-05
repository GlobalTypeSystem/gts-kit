import type { PropertyInfo } from '@/lib/schemaParser'

/**
 * A validation error shape that is enough to match it against a property.
 * Mirrors the ValidationError produced by the shared registry/validator.
 */
export interface ValidationErrorLike {
  instancePath: string
  message: string
  keyword?: string
  params?: any
}

/**
 * Normalize an Ajv/GTS instancePath into a property "path tree" that matches how
 * PropertyViewer builds property paths. Collapses Ajv `/properties/` segments,
 * turns bracket indices into pointer segments and strips trailing annotation/
 * sub-keys (e.g. `/x-*`, `/type`, `/const`, `/$ref`, `/items`).
 */
export function normalizeInstancePath(p: string): string {
  if (!p) return p
  // Collapse /properties/ segments used by Ajv
  let out = p.replace(/\/properties\//g, '/')
  // Convert bracket indices to pointer-style segments: allOf[1] -> allOf/1
  out = out.replace(/\[(\d+)\]/g, '/$1')
  // Iteratively strip trailing leaf nodes that refer to annotations or sub-keys
  const tail = /\/(x-[^/]+|type|const|\$ref|items)$/
  let i = 0
  while (tail.test(out) && i++ < 10) {
    out = out.replace(tail, '')
  }
  return out
}

/**
 * Whether a validation error is displayed inline next to the property identified
 * by `propertyPath` (e.g. "/id") with the given `propertyName`.
 *
 * This is the single source of truth used both by PropertyViewer (to render the
 * inline error box) and by SchemaNodeView (to avoid repeating the same error in
 * the top-level "Validation Errors" summary).
 */
export function errorMatchesProperty(
  err: ValidationErrorLike,
  propertyPath: string,
  propertyName: string
): boolean {
  const propertyPathTree = normalizeInstancePath(propertyPath)
  const errPath = err.instancePath || ''
  const errNorm = normalizeInstancePath(errPath.trim())
  const errParentNorm = normalizeInstancePath(errPath.trim().replace(/\/x-[^/]+$/, ''))

  // Direct matches (raw and normalized)
  if (errPath === propertyPath) return true
  if (errNorm === propertyPathTree) return true

  // Parent of /x-* annotation should map to the property itself
  if (errParentNorm === propertyPathTree) return true

  // additionalProperties errors carry the offending property name in the message
  // e.g. "must NOT have additional property 'retention2'"
  if (err.keyword === 'additionalProperties' && err.message) {
    const match = err.message.match(/must NOT have additional property ['"]([^'"]+)['"]/)
    if (match && match[1] === propertyName) return true
  }

  return false
}

/**
 * Whether the error maps to one of the given top-level properties. Only the top
 * level is considered because those rows are always rendered (nested rows may be
 * collapsed), so an error mapped here is guaranteed to be shown inline and can be
 * safely omitted from the summary to avoid showing it twice.
 */
export function isErrorMappedToTopLevelProperty(
  err: ValidationErrorLike,
  properties: PropertyInfo[] | undefined | null
): boolean {
  if (!properties) return false
  for (const property of properties) {
    const propertyPath = `/${property.name}`
    if (errorMatchesProperty(err, propertyPath, property.name)) return true
  }
  return false
}
