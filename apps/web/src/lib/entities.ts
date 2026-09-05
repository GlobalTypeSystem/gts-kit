// ---- Helpers  ----
// GTS ID validation/extraction is delegated to gts-ts via @gts/shared,
// so this app no longer repeats the GTS grammar or extraction rules.
import { isGtsId, extractID, IS_UUID_REGEX } from '@gts/shared'

// ---- Entities ----


export interface ValidationResult {
    errors: string[]
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
            if (isGtsId(node)) found.push({ id: node, sourcePath: currentPath || 'root' })
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
    /** Entity/instance id, extracted via gts-ts extractID. Falls back to file path. */
    calcJsonObjId(): string {
      const id = extractID(this.content).id
      if (id) return id
      return this.listSequence !== undefined ? `${this.file?.path}#${this.listSequence}` : this.file?.path || ''
    }
    /** Schema/type id, extracted via gts-ts extractID. Falls back to file path. */
    calcJsonSchemaId(): string {
        const result = extractID(this.content)
        // For a schema document, its own id is the type id; for an instance the
        // type id is the schema it derives from.
        const schemaId = result.is_type_schema ? result.id : result.type_id
        if (schemaId) return schemaId
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
      if (isGtsId(node)) found.push({ id: node, sourcePath: currentPath || 'value' })
      return
    }
    if (typeof node !== 'object') return
    let hasConstGts = false
    if (Object.prototype.hasOwnProperty.call(node, 'const')) {
      const v = (node as any).const
      if (typeof v === 'string' && isGtsId(v)) {
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
