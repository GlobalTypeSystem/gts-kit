// ---- Helpers  ----
import { AppConfig } from '@/lib/config'

export const GTS_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*~?\s*$/
export const GTS_OBJ_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*\s*$/
export const GTS_TYPE_REGEX = /^\s*gts\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:~[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.v(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)*~\s*$/
export const IS_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Defaults are managed by AppConfig singleton; no defaults exported here

// ---- Entities ----

export interface ValidationResult {
    errors: string[]
}

export interface SchemaNode {
    id: string  // Node ID based on content $id or fallback
    type: 'json' | 'schema'
    data: {
        label: string
        nodeId: string  // Same as parent id, for consistency
        content: any
        properties?: PropertyInfo[]
        schemaId?: string  // Schema ID reference, not path
        validation?: ValidationResult
        references?: Array<{ id: string, sourcePath: string }>
        gtsIds?: Array<{ id: string, sourcePath: string }>
    }
    position: { x: number; y: number }
}

export interface PropertyInfo {
    name: string
    type: string
    value?: any
    required?: boolean
    description?: string
    children?: PropertyInfo[]
    isGtsType?: boolean
    isGtsObj?: boolean
}

export class JsonFile {
    path: string
    name: string
    content: any
    sequencesCount: number
    sequenceContent: Map<number, any>
    constructor(path: string, name: string, content: any) {
        this.path = path
        this.name = name
        this.content = content
        this.sequencesCount = 0
        this.sequenceContent = new Map<number, any>()

        Array.isArray(content) ? content : [content].forEach((item, index) => {
            this.sequencesCount++
            this.sequenceContent.set(index, item)
        })
    }
}

export class WebJsonEntity {
    id: string
    isSchema: boolean
    file?: JsonFile
    listSequence?: number
    label?: string
    content: any
    gtsRefs?: Array<{ id: string; sourcePath: string }>
    validation?: ValidationResult
    schemaId?: string
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any
    }) {
        this.id = 'undefined'
        this.isSchema = false
        this.file = params.file
        this.listSequence = params.listSequence
        this.content = params.content
        this.label = (params.listSequence !== undefined ? `${params.file?.name}#${params.listSequence}` : params.file?.name) || ''
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
              walk(v, nextPath)
            })
          }
        }
        walk(this.content)
        const uniq = new Map<string, { id: string; sourcePath: string }>()
        for (const e of found) uniq.set(`${e.id}|${e.sourcePath}`, e)
        return Array.from(uniq.values())
    }
    firstNonEmptyField(fields: string[]): string | undefined {
        // Prefer fields that look like GTS IDs
        for (const f of fields) {
          const v = this.content?.[f]
          if (typeof v === 'string' && v.trim() && GTS_REGEX.test(v)) return v
        }
        for (const f of fields) {
          const v = this.content?.[f]
          if (typeof v === 'string' && v.trim()) return v
        }
        return undefined
    }
    calcJsonObjId(): string {
      const fields: string[] = AppConfig.get().gts.entity_id_fields
      const candidate = this.firstNonEmptyField(fields)
      if (candidate) return candidate
      return this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
    }
    calcJsonSchemaId(): string {
        const fields: string[] = AppConfig.get().gts.schema_id_fields
        const candidate = this.firstNonEmptyField(fields)
        if (candidate) return candidate

        // No explicit schema id found in configured fields.
        // If the object id is a GTS id, derive the schema type as the left part up to the last '~' (inclusive).
        const id = this.calcJsonObjId()
        if (id && GTS_REGEX.test(id)) {
          // If already a type id (ends with '~'), use it as-is
          if (id.endsWith('~')) return id
          // Otherwise, trim to the last '~' to get the type id
          const lastTilde = id.lastIndexOf('~')
          if (lastTilde > 0) {
            return id.substring(0, lastTilde + 1)
          }
        }

        // Fallback to file path
        return this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
    }
}

export class JsonObj extends WebJsonEntity {
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any
    }) {
        super(params)
        this.id = this.calcJsonObjId()
        this.schemaId = this.calcJsonSchemaId()
        if (this.id) {
          if (IS_UUID_REGEX.test(this.id)) {
            this.label = this.schemaId + '' + this.id
          } else {
            this.label = this.id
          }
        }
    }
}

export class JsonSchema extends WebJsonEntity {
    schemaRefs: Array<{ id: string; sourcePath: string }>
    constructor(params: {
        file?: JsonFile
        listSequence?: number
        content: any
    }) {
        super(params)
        this.isSchema = true
        this.id = this.calcJsonSchemaId()
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

export function extractGtsConstIdsWithPaths(schema: any): Array<{ id: string; sourcePath: string }> {
  const found: Array<{ id: string; sourcePath: string }> = []
  function walk(node: any, currentPath = ''): void {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      if (GTS_REGEX.test(node)) found.push({ id: node, sourcePath: currentPath || 'value' })
      return
    }
    if (typeof node !== 'object') return
    let hasConstGts = false
    if (Object.prototype.hasOwnProperty.call(node, 'const')) {
      const v = (node as any).const
      if (typeof v === 'string' && GTS_REGEX.test(v)) {
        found.push({ id: v, sourcePath: currentPath ? `${currentPath}.const` : 'const' })
        hasConstGts = true
      }
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${currentPath}[${i}]`))
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (hasConstGts && k === 'const') continue
      const next = currentPath ? `${currentPath}.${k}` : k
      walk(v, next)
    }
  }
  walk(schema)
  const uniq = new Map<string, { id: string; sourcePath: string }>()
  for (const e of found) uniq.set(`${e.id}|${e.sourcePath}`, e)
  return Array.from(uniq.values())
}
