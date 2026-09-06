import { parseGtsFileContent, isYamlFileName } from './parse.js'
import {
  validateGtsID as gtsValidateID,
  matchIDPattern as gtsMatchIDPattern,
  extractID as gtsExtractID,
  Gts
} from '@globaltypesystem/gts-ts'
import type {
  ValidationResult as GtsValidationResult,
  MatchResult as GtsMatchResult,
  ExtractResult as GtsExtractResult
} from '@globaltypesystem/gts-ts'

// Re-export core gts-ts functions for direct use by consumers
export { gtsValidateID as validateGtsID, gtsMatchIDPattern as matchIDPattern, gtsExtractID as extractID }
export type { GtsValidationResult, GtsMatchResult, GtsExtractResult }

// ---- GTS ID validation (delegates to gts-ts) ----

export const IS_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The gts:// prefix used in JSON Schema $id and $ref for URI compatibility */
export const GTS_URI_PREFIX = 'gts://'

/**
 * Normalize a GTS identifier by stripping the gts:// prefix if present.
 * Per GTS spec, $id and $ref in JSON Schemas use gts:// prefix for URI compatibility,
 * but the canonical identifier starts with "gts." without the URI prefix.
 *
 * @param id - The GTS identifier (may have gts:// prefix)
 * @returns The canonical GTS identifier without gts:// prefix
 *
 * @example
 * normalizeGtsId('gts://gts.x.core.events.type.v1~') // returns 'gts.x.core.events.type.v1~'
 * normalizeGtsId('gts.x.core.events.type.v1~')       // returns 'gts.x.core.events.type.v1~'
 */
export function normalizeGtsId(id: string): string {
  if (!id || typeof id !== 'string') return id
  const trimmed = id.trim()
  if (trimmed.startsWith(GTS_URI_PREFIX)) {
    return trimmed.substring(GTS_URI_PREFIX.length)
  }
  return trimmed
}

/**
 * Check if a string is a valid GTS identifier (with or without gts:// prefix).
 * Delegates to the official gts-ts library.
 * Does NOT accept wildcard patterns — use {@link isGtsIdOrPattern} for that.
 */
export function isGtsId(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  const normalized = normalizeGtsId(value)
  const result = gtsValidateID(normalized)
  return result.ok && !result.is_wildcard
}

/**
 * Check if a string is a valid GTS type identifier (ends with ~).
 * Delegates to the official gts-ts library.
 */
export function isGtsType(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  const normalized = normalizeGtsId(value)
  return isGtsId(normalized) && Gts.isType(normalized)
}

/**
 * Check if a string is a valid GTS object/instance identifier (does not end with ~).
 * Delegates to the official gts-ts library.
 */
export function isGtsObj(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  const normalized = normalizeGtsId(value)
  return isGtsId(normalized) && !Gts.isType(normalized)
}

/**
 * Check if a string is a valid GTS identifier OR a GTS wildcard pattern
 * (e.g. "gts.*", "gts.vendor.pkg.*"). Uses the official gts-ts library
 * for validation, which supports the full GTS spec including wildcards.
 *
 * @param value - The string to check (may have gts:// prefix)
 * @returns true if the value is a valid GTS ID or wildcard pattern
 *
 * @example
 * isGtsIdOrPattern('gts.x.core.events.type.v1~')  // true (full ID)
 * isGtsIdOrPattern('gts.*')                         // true (wildcard)
 * isGtsIdOrPattern('gts.vendor.pkg.*')              // true (wildcard)
 * isGtsIdOrPattern('not-a-gts-id')                  // false
 */
export function isGtsIdOrPattern(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  const normalized = normalizeGtsId(value)
  const result = gtsValidateID(normalized)
  return result.ok
}

/**
 * Check if a string is a GTS wildcard pattern (contains `*`).
 * Returns false for full GTS IDs without wildcards.
 *
 * @param value - The string to check (may have gts:// prefix)
 * @returns true only if the value is a valid GTS wildcard pattern
 *
 * @example
 * isGtsPattern('gts.*')                         // true
 * isGtsPattern('gts.vendor.pkg.*')              // true
 * isGtsPattern('gts.x.core.events.type.v1~')   // false (full ID, not a pattern)
 */
export function isGtsPattern(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  const normalized = normalizeGtsId(value)
  const result = gtsValidateID(normalized)
  return result.ok && (result.is_wildcard === true)
}

/**
 * Check if a GTS x-gts-ref value is valid. Accepts:
 * - Full GTS type IDs (e.g. "gts.vendor.pkg.ns.type.v1~")
 * - Wildcard patterns (e.g. "gts.*", "gts.vendor.pkg.*")
 * - JSON Pointer references starting with "/" (e.g. "/$id")
 *
 * Uses the official gts-ts library for GTS ID/pattern validation.
 */
export function isValidXGtsRef(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  // JSON Pointer references are valid x-gts-ref values
  if (value.startsWith('/')) return true
  // Otherwise validate as GTS ID or pattern
  return isGtsIdOrPattern(value)
}

/**
 * JSON object field names (leaf keys) whose string values are consumed by JSON
 * Schema as URLs and therefore MUST carry the gts:// URI prefix when they hold a
 * GTS identifier. Everywhere else a GTS identifier MUST be written in canonical
 * form (gts.<...>) WITHOUT the gts:// prefix.
 *
 * @see https://json-schema.org — $id / $ref are resolved as URI references.
 */
export const GTS_URI_PREFIX_FIELDS: readonly string[] = ['$id', '$ref', 'x-gts-traits-schema']

/**
 * Whether GTS identifiers appearing as the value of the given field must carry the
 * gts:// URI prefix (i.e. the field is a JSON Schema URL context).
 */
export function fieldRequiresGtsUriPrefix(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false
  return GTS_URI_PREFIX_FIELDS.includes(fieldName)
}

/** Kind of gts:// prefix problem detected for a GTS identifier in a specific field. */
export type GtsPrefixIssueKind = 'missing-uri-prefix' | 'unexpected-uri-prefix' | 'invalid-gts-uri'

/** A detected gts:// prefix problem, with a human-readable explanation. */
export interface GtsPrefixIssue {
  kind: GtsPrefixIssueKind
  /** Human-readable explanation suitable for a diagnostic/hover popup. */
  message: string
  /** The corrected value the user should use instead of the raw value. */
  suggestion: string
}

/**
 * Validate gts:// prefix usage of a GTS identifier value against the field it lives
 * in. Returns a {@link GtsPrefixIssue} when the prefix usage is wrong, otherwise null.
 *
 * Rules (per GTS spec):
 * - In JSON Schema URL fields ({@link GTS_URI_PREFIX_FIELDS}) a GTS identifier MUST
 *   start with "gts://gts." — a bare "gts." value is malformed.
 * - In every other field a GTS identifier MUST start with "gts." — a "gts://" value
 *   is malformed.
 *
 * Only actual GTS identifiers are considered; non-GTS strings return null so that
 * malformed-format handling stays a separate concern.
 *
 * @param fieldName - The JSON leaf key the value is assigned to (e.g. "$id", "type").
 * @param rawValue - The original, un-normalized string value.
 */
export function checkGtsUriPrefix(fieldName: string | undefined | null, rawValue: string): GtsPrefixIssue | null {
  if (typeof rawValue !== 'string') return null

  const trimmed = rawValue.trim()

  // Detect gts:// URI prefix followed by an invalid GTS identifier body.
  // E.g. "gts://gtx.cf.chat_engine.entities.client_id.v1~" — the part after
  // "gts://" does not start with "gts." and is therefore not a valid GTS ID.
  if (trimmed.startsWith(GTS_URI_PREFIX) && !isGtsId(rawValue)) {
    const body = trimmed.substring(GTS_URI_PREFIX.length)
    const where = fieldName ? ` in "${fieldName}"` : ''
    return {
      kind: 'invalid-gts-uri',
      suggestion: GTS_URI_PREFIX + 'gts.' + body.substring(body.indexOf('.') + 1),
      message: `Malformed GTS identifier${where}: value starts with "${GTS_URI_PREFIX}" but "${body}" is not a valid GTS identifier (must start with "gts.").`
    }
  }

  if (!isGtsId(rawValue)) return null
  const hasPrefix = trimmed.startsWith(GTS_URI_PREFIX)
  const requiresPrefix = fieldRequiresGtsUriPrefix(fieldName)
  const canonical = normalizeGtsId(rawValue)

  if (requiresPrefix && !hasPrefix) {
    return {
      kind: 'missing-uri-prefix',
      suggestion: GTS_URI_PREFIX + canonical,
      message: `Malformed GTS identifier in "${fieldName}": JSON Schema treats this value as a URL, so it must start with "${GTS_URI_PREFIX}gts.". Use "${GTS_URI_PREFIX}${canonical}".`
    }
  }
  if (!requiresPrefix && hasPrefix) {
    const where = fieldName ? ` in "${fieldName}"` : ''
    return {
      kind: 'unexpected-uri-prefix',
      suggestion: canonical,
      message: `Malformed GTS identifier${where}: the "${GTS_URI_PREFIX}" URI prefix is only allowed in JSON Schema URL fields (${GTS_URI_PREFIX_FIELDS.join(', ')}). Use "${canonical}".`
    }
  }
  return null
}

/** A gts:// prefix violation located at a specific path within a JSON document. */
export interface GtsPrefixViolation {
  fieldName: string
  rawValue: string
  /** Dot/bracket path to the offending value (e.g. "allOf[0].$ref"), or "root". */
  sourcePath: string
  issue: GtsPrefixIssue
}

/**
 * Walk arbitrary JSON content and report every gts:// prefix violation, keyed by the
 * leaf field name each string value is assigned to. Array elements inherit the field
 * name of their containing property (e.g. entries of an "enum" array are checked as
 * "enum" values).
 */
export function findGtsPrefixViolations(content: any): GtsPrefixViolation[] {
  const out: GtsPrefixViolation[] = []
  function walk(node: any, currentPath: string, fieldName: string): void {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      const issue = checkGtsUriPrefix(fieldName, node)
      if (issue) out.push({ fieldName, rawValue: node, sourcePath: currentPath || 'root', issue })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${currentPath}[${i}]`, fieldName))
      return
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const nextPath = currentPath ? `${currentPath}.${k}` : k
        walk(v, nextPath, k)
      }
    }
  }
  walk(content, '', '')
  return out
}

// ---- Color Definitions ----

/**
 * Color scheme for GTS entities
 * Used consistently across web, VS Code extension, and other UIs
 */
export const GTS_COLORS = {
  schema: {
    // Schema entities (JsonSchema): blue colors
    foreground: '#bae6fd',  // Tailwind text-sky-200
    background: '#0369a1',  // Tailwind bg-sky-700
    background_transparent: '#0369a1f0',  // Tailwind bg-sky-700
  },
  instance: {
    // Instance entities (JsonObj): green colors
    foreground: '#bbf7d0',  // Tailwind text-green-200
    background: '#15803d',  // Tailwind bg-green-700
    background_transparent: '#15803df0',  // Tailwind green-200
  },
  invalid: {
    // Invalid files: red colors
    foreground: '#fecaca',  // Tailwind text-red-200
    background: '#b91c1c',  // Tailwind bg-red-700
    background_transparent: '#b91c1cf0',  // Tailwind bg-red-700
  },
  unresolved: {
    // Valid GTS format but entity not found in project (e.g. examples): gray
    foreground: '#d4d4d8',  // Tailwind zinc-300
    background: '#52525b',  // Tailwind zinc-600
    background_transparent: '#52525bf0',
  }
} as const

/**
 * Decode a GTS entity ID from URL encoding to ASCII and normalize it.
 * Handles multiple levels of encoding (e.g., %257E -> %7E -> ~).
 * Also strips the gts:// prefix if present (per GTS spec).
 *
 * @param id - The potentially URL-encoded entity ID (may have gts:// prefix)
 * @returns The fully decoded and normalized entity ID in ASCII
 *
 * @example
 * decodeGtsId('gts.x.core.events.type.v1%7E') // returns 'gts.x.core.events.type.v1~'
 * decodeGtsId('gts://gts.x.core.events.type.v1~') // returns 'gts.x.core.events.type.v1~'
 * decodeGtsId('gts.x.core.events.topic.v1%7Ex.core.idp.contacts.v1') // returns 'gts.x.core.events.topic.v1~x.core.idp.contacts.v1'
 */
export function decodeGtsId(id: string): string {
  let decodedId = id
  let previousId = ''

  // Decode repeatedly until no more decoding is possible
  while (decodedId !== previousId) {
    previousId = decodedId
    try {
      decodedId = decodeURIComponent(decodedId)
    } catch (e) {
      // If decoding fails, use the last valid decoded value
      break
    }
  }

  // Normalize by stripping gts:// prefix if present
  return normalizeGtsId(decodedId)
}

// Defaults are managed by AppConfig singleton; no defaults exported here

export interface GtsConfig {
  entity_id_fields: string[]
  schema_id_fields: string[]
}

export const DEFAULT_GTS_CONFIG: GtsConfig = {
  entity_id_fields: ["$id","gtsId", "gtsIid", "gtsOid", "gtsI", "gts_id", "gts_oid", "gts_iid", "id"],
  schema_id_fields: ["$schema", "gtsTid", "gtsT", "gts_t", "gts_tid", "type", "schema"],
}

export function getGtsConfig(cfg?: GtsConfig): GtsConfig {
  if (!cfg) return DEFAULT_GTS_CONFIG
  let config = {...DEFAULT_GTS_CONFIG}
  if (cfg.entity_id_fields && cfg.entity_id_fields.length) config.entity_id_fields = cfg.entity_id_fields
  if (cfg.schema_id_fields && cfg.schema_id_fields.length) config.schema_id_fields = cfg.schema_id_fields
  return config
}

// ---- Entities ----

/**
 * Detailed validation error for a specific field or constraint
 */
export interface ValidationError {
    /** Path to the field in the data (e.g., '/users/0/email') */
    instancePath: string
    /** Path to the schema rule that failed (e.g., '#/properties/email/format') */
    schemaPath: string
    /** The validation keyword that failed (e.g., 'type', 'pattern', 'required', 'anyOf') */
    keyword: string
    /** Human-readable error message */
    message: string
    /** Keyword-specific parameters providing additional context */
    params: Record<string, any>
    /** The actual value that failed validation (if applicable) */
    data?: any
}

/**
 * Result of validating a JSON entity against its schema
 */
export interface ValidationResult {
    /** Detailed errors for each validation failure */
    errors: ValidationError[]
}

export class JsonFile {
    path: string
    name: string
    content: any
    sequencesCount: number
    sequenceContent: Map<number, any>
    validation?: ValidationResult
    constructor(path: string, name: string, content: any) {
        this.path = path
        this.name = name
        this.content = content
        this.sequencesCount = 0
        this.sequenceContent = new Map<number, any>()

        this.validation = { errors: [] }
        if (typeof content === 'string') {
            try {
              // Parse by extension so YAML files are not mis-parsed as JSONC.
              const parsed = parseGtsFileContent(name, content)
              this.content = parsed
            } catch (e) {
              const kind = isYamlFileName(name) ? 'YAML' : 'JSON'
              this.validation.errors.push({
                  instancePath: '',
                  schemaPath: '#',
                  keyword: 'type',
                  message: `Invalid ${kind}: ` + e,
                  params: { type: 'object' }
              })
            }
        }

        Array.isArray(content) ? content : [content].forEach((item, index) => {
            this.sequencesCount++
            this.sequenceContent.set(index, item)
        })
    }
}

export class JsonEntity {
    id: string
    isSchema: boolean
    file?: JsonFile
    listSequence?: number
    label?: string
    content: any
    gtsRefs?: Array<{ id: string; sourcePath: string }>
    validation?: ValidationResult
    schemaId?: string
    /** Which field produced id (e.g., "$id", "id") */
    selectedEntityIdField?: string
    /** Which field produced schemaId (e.g., "$schema", "type"); if derived from id, equals selectedEntityIdField */
    selectedSchemaIdField?: string
    description?: string
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any,
        cfg: GtsConfig
    }) {
        this.id = 'undefined'
        this.isSchema = false
        this.file = params.file
        this.listSequence = params.listSequence
        this.content = params.content
        this.label = (params.listSequence !== undefined ? `${params.file?.name}#${params.listSequence}` : params.file?.name) || ''
        this.gtsRefs = this.extractGtsIdsFromJsonWithPaths()
        this.description = this.content?.description || ''
        this.validation = { errors: [] }
    }
    isGtsEntity(): boolean {
        if (this.id?.startsWith('gts.')) return true
        if (this.gtsRefs?.length) return true
        if (this.schemaId?.startsWith('gts.')) return true
        // Detect GTS intent from raw content: if $id or $$id starts with "gts://"
        // the author intended a GTS identifier, even if the body is malformed
        // (e.g. "gts://gtx.foo.bar.v1~" — typo in the prefix after gts://).
        const rawId = this.content?.['$id'] || this.content?.['$$id']
        if (typeof rawId === 'string' && rawId.trim().startsWith(GTS_URI_PREFIX)) return true
        return false
    }
    /**
     * Walk the entity content and collect all GTS ID references with their paths.
     * Uses gts-ts isValidGtsID for ID validation.
     */
    extractGtsIdsFromJsonWithPaths(): Array<{ id: string; sourcePath: string }> {
        const found: Array<{ id: string; sourcePath: string }> = []
        function walk(node: any, currentPath = ''): void {
          if (node === null || node === undefined) return
          if (typeof node === 'string') {
            const normalized = normalizeGtsId(node)
            if (isGtsId(normalized)) found.push({ id: normalized, sourcePath: currentPath || 'root' })
            return
          }
          if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${currentPath}[${index}]`))
            return
          }
          if (typeof node === 'object') {
            Object.entries(node).forEach(([k, v]) => {
              const nextPath = currentPath ? `${currentPath}.${k}` : k
              if (typeof v === 'string') {
                const normalized = normalizeGtsId(v)
                if (isGtsId(normalized)) {
                  found.push({ id: normalized, sourcePath: nextPath })
                }
              }
              walk(v, nextPath)
            })
          }
        }
        walk(this.content)
        const uniq = new Map<string, { id: string; sourcePath: string }>()
        for (const e of found) uniq.set(`${e.id}|${e.sourcePath}`, e)
        return Array.from(uniq.values())
    }
    /**
     * Extract entity ID and schema/type ID using gts-ts extractID.
     * Populates id, schemaId, isSchema, selectedEntityIdField, selectedSchemaIdField.
     */
    applyGtsExtraction(_cfg: GtsConfig): void {
        const result = gtsExtractID(this.content)
        if (result.id) {
          this.id = result.id
          this.selectedEntityIdField = result.selected_entity_field
        }
        if (result.type_id) {
          this.schemaId = result.type_id
          this.selectedSchemaIdField = result.selected_type_id_field
        }
        this.isSchema = result.is_type_schema
    }
    validate() {
      // Validate the entity against its schema
    }
}

export class JsonObj extends JsonEntity {
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any,
        cfg: GtsConfig
    }) {
        super(params)
        // Use gts-ts extractID for ID extraction
        this.applyGtsExtraction(params.cfg)
        // Fallback: if extractID didn't find an id, use file path
        if (!this.id || this.id === 'undefined') {
          this.id = this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
        }
        if (this.id) {
          if (IS_UUID_REGEX.test(this.id)) {
            this.label = this.schemaId + '' + this.id
          } else {
            this.label = this.id
          }
        }
    }
}

export class JsonSchema extends JsonEntity {
    schemaRefs: Array<{ id: string; sourcePath: string }>
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any,
        cfg: GtsConfig
    }) {
        super(params)
        // Use gts-ts extractID for ID extraction
        this.applyGtsExtraction(params.cfg)
        this.isSchema = true
        // Fallback: if extractID didn't find an id, use file path
        if (!this.id || this.id === 'undefined') {
          this.id = this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
        }
        this.schemaRefs = this.extractRefStringsWithPaths()
        this.label = this.id || this.file?.name || ''
    }

    extractRefStringsWithPaths(): Array<{ id: string; sourcePath: string }> {
        const refs: Array<{ id: string; sourcePath: string }> = []
        function walk(node: any, currentPath = ''): void {
          if (!node || typeof node !== 'object') return
          if (typeof (node as any).$ref === 'string') {
            const refValue = normalizeGtsId((node as any).$ref)
            refs.push({ id: refValue, sourcePath: currentPath ? `${currentPath}.$ref` : '$ref' })
          }
          if (Array.isArray(node)) {
            node.forEach((item, i) => walk(item, `${currentPath}[${i}]`))
            return
          }
          for (const [k, v] of Object.entries(node)) {
            const next = currentPath ? `${currentPath}.${k}` : k
            if (v && typeof v === 'object') walk(v, next)
          }
        }
        walk(this.content)
        const uniq = new Map<string, { id: string; sourcePath: string }>()
        for (const r of refs) uniq.set(`${r.id}|${r.sourcePath}`, r)
        return Array.from(uniq.values())
    }
}

// ---- Consolidated helpers ----

/**
 * Check if an object looks like a JSON Schema.
 * Delegates to gts-ts extractID for schema detection per GTS spec.
 */
export function looksLikeJsonSchema(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false
  return gtsExtractID(obj).is_type_schema
}

/**
 * Create a JsonObj or JsonSchema entity from content.
 * Uses gts-ts extractID to determine if the content is a schema or instance.
 */
export function createEntity(params: {
  file?: JsonFile
  listSequence?: number
  content: any
  cfg: GtsConfig
  extractGtsRefs?: (entity: any) => Array<{ id: string; sourcePath: string }>
}): JsonObj | JsonSchema | null {
  const extractResult = gtsExtractID(params.content)
  if (extractResult.is_type_schema) {
    return new JsonSchema({ file: params.file, listSequence: params.listSequence, content: params.content, cfg: params.cfg })
  }

  return new JsonObj({ file: params.file, listSequence: params.listSequence, content: params.content, cfg: params.cfg })
}

export function createAbsentEntity(id: string): JsonEntity {
  let entity = new JsonEntity({
    file: undefined,
    listSequence: undefined,
    content: undefined,
    cfg: getGtsConfig()
  })
  entity.id = id
  entity.validation = { errors: [{
    instancePath: '',
    schemaPath: '#',
    keyword: '',
    message: `GTS entity not found: ${id}`,
    params: { gtsId: id }
  }] }
  return entity
}
