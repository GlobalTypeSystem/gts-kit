import { parseJSONC } from './jsonc.js'

// ---- Helpers  ----

export const GTS_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*~?\s*$/
export const GTS_OBJ_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*\s*$/
export const GTS_TYPE_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*~\s*$/
export const IS_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
  }
} as const

/**
 * Decode a GTS entity ID from URL encoding to ASCII.
 * Handles multiple levels of encoding (e.g., %257E -> %7E -> ~).
 *
 * @param id - The potentially URL-encoded entity ID
 * @returns The fully decoded entity ID in ASCII
 *
 * @example
 * decodeGtsId('gts.x.core.events.type.v1%7E') // returns 'gts.x.core.events.type.v1~'
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

  return decodedId
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
              const parsed = parseJSONC(content)
              this.content = parsed
            } catch (e) {
              this.validation.errors.push({
                  instancePath: '',
                  schemaPath: '#',
                  keyword: 'type',
                  message: 'Invalid JSONC: ' + e,
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
        return false
    }
    extractGtsIdsFromJsonWithPaths(): Array<{ id: string; sourcePath: string }> {
        const found: Array<{ id: string; sourcePath: string }> = []
        function walk(node: any, currentPath = ''): void {
          if (node === null || node === undefined) return
          if (typeof node === 'string') {
            if (GTS_REGEX.test(node)) found.push({ id: node, sourcePath: currentPath || 'root' })
            return
          }
          if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${currentPath}[${index}]`))
            return
          }
          if (typeof node === 'object') {
            Object.entries(node).forEach(([k, v]) => {
              const nextPath = currentPath ? `${currentPath}.${k}` : k
              // Check if this is a field with a GTS ID value
              if (typeof v === 'string' && GTS_REGEX.test(v)) {
                found.push({ id: v, sourcePath: nextPath })
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
    firstNonEmptyField(fields: string[]): { field: string, value: string } | undefined {
        // Prefer fields that look like GTS IDs
        for (const f of fields) {
          const v = this.content?.[f]
          if (typeof v === 'string' && v.trim() && GTS_REGEX.test(v)) return { field: f, value: v }
        }
        for (const f of fields) {
          const v = this.content?.[f]
          if (typeof v === 'string' && v.trim()) return { field: f, value: v }
        }
        return undefined
    }
    calcJsonEntityId(cfg: GtsConfig): string {
      const fields: string[] = cfg.entity_id_fields
      const candidate = this.firstNonEmptyField(fields)
      if (candidate) {
        this.selectedEntityIdField = candidate.field
        return candidate.value
      }
      return this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
    }
    calcJsonSchemaId(cfg: GtsConfig): string {
        const fields: string[] = cfg.schema_id_fields
        const candidate = this.firstNonEmptyField(fields)
        if (candidate) {
          this.selectedSchemaIdField = candidate.field
          return candidate.value
        }

        // No explicit schema id found in configured fields.
        // If the object id is a GTS id, derive the schema type as the left part up to the last '~' (inclusive).
        const id = this.calcJsonEntityId(cfg)
        if (id && GTS_REGEX.test(id)) {
          // If already a type id (ends with '~'), use it as-is
          if (id.endsWith('~')) return id
          // Otherwise, trim to the last '~' to get the type id
          const lastTilde = id.lastIndexOf('~')
          if (lastTilde > 0) {
            // Mark schema derived from the entity id field
            this.selectedSchemaIdField = this.selectedEntityIdField
            return id.substring(0, lastTilde + 1)
          }
        }

        // Fallback to file path
        return this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
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
        this.id = this.calcJsonEntityId(params.cfg)
        this.schemaId = this.calcJsonSchemaId(params.cfg)
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
        this.isSchema = true
        this.id = this.calcJsonEntityId(params.cfg)
        this.schemaId = this.calcJsonSchemaId(params.cfg)
        this.schemaRefs = this.extractRefStringsWithPaths()
        this.label = this.id || this.file?.name || ''
    }

    extractRefStringsWithPaths(): Array<{ id: string; sourcePath: string }> {
        const refs: Array<{ id: string; sourcePath: string }> = []
        function walk(node: any, currentPath = ''): void {
          if (!node || typeof node !== 'object') return
          if (typeof (node as any).$ref === 'string') {
            refs.push({ id: (node as any).$ref, sourcePath: currentPath ? `${currentPath}.$ref` : '$ref' })
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
export function looksLikeJsonSchema(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false
  return (
    typeof (obj as any).$schema === 'string' ||
    typeof (obj as any).$id === 'string' ||
    (typeof (obj as any).type === 'string' && typeof (obj as any).properties === 'object')
  )
}

/**
 * Determine if an entity is a JSON Schema based on $schema URL.
 * Schemas always have $schema referring standard json schema URL.
 */
function isJsonSchemaEntity(entity: any): boolean {
  if (!entity || typeof entity !== 'object') return false
  if (!entity.hasOwnProperty('$schema')) return false
  if (typeof entity.$schema !== 'string') return false
  const url = entity.$schema
  if (url.startsWith("http://json-schema.org/")) return true
  if (url.startsWith("https://json-schema.org/")) return true
  if (url.startsWith("gts://")) return true
  if (url.startsWith("gts.")) return true
  return false
}

export function createEntity(params: {
  file?: JsonFile
  listSequence?: number
  content: any
  cfg: GtsConfig
  extractGtsRefs?: (entity: any) => Array<{ id: string; sourcePath: string }>
}): JsonObj | JsonSchema | null {
  if (isJsonSchemaEntity(params.content)) {
    return  new JsonSchema({ file: params.file, listSequence: params.listSequence, content: params.content, cfg: params.cfg })
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
