import { JsonFile, JsonObj, JsonSchema, createEntity, getGtsConfig, decodeGtsId, createAbsentEntity } from './entities.js'
import type { GtsConfig, JsonEntity, ValidationResult, ValidationError } from './entities.js'
import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import * as path from 'path'

/**
 * Helper to normalize content to array for processing
 */
function normalizeToArray(content: any): any[] {
  return Array.isArray(content) ? content : [content]
}

/**
 * JsonRegistry: central store and fetch cache for JsonFile/JsonObj/JsonSchema
 */
export class JsonRegistry {
  // Entity maps
  jsonObjs: Map<string, JsonObj>
  jsonSchemas: Map<string, JsonSchema>
  jsonFiles: Map<string, JsonFile>
  invalidFiles: Map<string, JsonFile>
  jsonFileObjs: Map<string, JsonObj[]>
  jsonFileSchemas: Map<string, JsonSchema[]>
  absentGtsEntities: Map<string, JsonEntity>

  // Centralized fetch cache
  private fetchCache: Map<string, Promise<any>>
  // Default file to open/select when displaying layout
  private defaultFilePath: string | null

  constructor() {
    this.jsonObjs = new Map<string, JsonObj>()
    this.jsonSchemas = new Map<string, JsonSchema>()
    this.jsonFiles = new Map<string, JsonFile>()
    this.invalidFiles = new Map<string, JsonFile>()
    this.fetchCache = new Map<string, Promise<any>>()
    this.jsonFileObjs = new Map<string, JsonObj[]>()
    this.jsonFileSchemas = new Map<string, JsonSchema[]>()
    this.absentGtsEntities = new Map<string, JsonEntity>()
    this.defaultFilePath = null
  }

  reset(): void {
    this.jsonObjs.clear()
    this.jsonSchemas.clear()
    this.jsonFiles.clear()
    this.invalidFiles.clear()
    this.fetchCache.clear()
    this.jsonFileObjs.clear()
    this.jsonFileSchemas.clear()
    this.defaultFilePath = null
  }

  /**
   * Invalidate a file and remove its JsonFile and associated records from the registry.
   */
  invalidateFile(path: string): void {
    if (this.jsonFiles.has(path)) {
      this.jsonFiles.delete(path)
    }
    if (this.invalidFiles.has(path)) {
      this.invalidFiles.delete(path)
    }
    if (this.jsonFileObjs.has(path)) {
      for (const obj of this.jsonFileObjs.get(path)!) {
        this.jsonObjs.delete(obj.id)
      }
      this.jsonFileObjs.delete(path)
      this.jsonFileObjs.set(path, [])
    }
    if (this.jsonFileSchemas.has(path)) {
      for (const schema of this.jsonFileSchemas.get(path)!) {
        this.jsonSchemas.delete(schema.id)
      }
      this.jsonFileSchemas.delete(path)
      this.jsonFileSchemas.set(path, [])
    }
  }

  /**
   * Process a file and store its entities if they are GTS entities.
   * This is a helper used by both scanFile and ingestFiles.
   */
  private processFileContent(path: string, name: string, content: any, cfg: GtsConfig): void {
    // Cleanup any existing records for this file
    this.invalidateFile(path)

    // Create JsonFile
    const jsonFile = new JsonFile(path, name, content)

    // Track if we found any GTS entities in this file
    let hasGtsEntities = false

    if (jsonFile.validation && jsonFile.validation.errors.length > 0) {
      // Store JsonFile if it's invalid to show it in the UI
      this.invalidFiles.set(path, jsonFile)
      return
    }

    // Normalize content to array and process each entity
    const entities = normalizeToArray(content)
    entities.forEach((entityContent: any, idx: number) => {
      const seq = Array.isArray(content) ? idx : undefined
      const entity = createEntity({
        file: jsonFile,
        listSequence: seq,
        content: entityContent,
        cfg
      })

      if (entity && entity.isGtsEntity()) {
        hasGtsEntities = true
        if (entity instanceof JsonSchema) {
          this.jsonSchemas.set(entity.id, entity)
          this.jsonFileSchemas.set(path, [...this.jsonFileSchemas.get(path) || [], entity])
        } else {
          this.jsonObjs.set(entity.id, entity as JsonObj)
          this.jsonFileObjs.set(path, [...this.jsonFileObjs.get(path) || [], entity as JsonObj])
        }
      }
    })

    // Only store the JsonFile once if it contains GTS entities
    if (hasGtsEntities && !this.jsonFiles.has(path)) {
      this.jsonFiles.set(path, jsonFile)
    }
  }

  /**
   * Validate a single entity against its schema.
   */
  async validateEntity(entity: JsonEntity): Promise<void> {
    // Initialize validation result
    entity.validation = { errors: [] }

    // Check if all GTS references exist in the registry
    if (entity.gtsRefs && entity.gtsRefs.length > 0) {
      for (const ref of entity.gtsRefs) {
        const refExists = this.jsonSchemas.has(ref.id) || this.jsonObjs.has(ref.id)
        if (!refExists) {
          this.absentGtsEntities.set(ref.id, createAbsentEntity(ref.id))
          // Convert sourcePath from dot notation to slash notation for instancePath
          // e.g., "contact.gtsIid" -> "/contact/gtsIid", "gtsIid" -> "/gtsIid"
          const instancePath = ref.sourcePath === 'root'
            ? '/'
            : '/' + ref.sourcePath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
          entity.validation.errors.push({
            instancePath,
            schemaPath: '#',
            keyword: '',
            message: `GTS reference not found: ${ref.id}`,
            params: { gtsId: ref.id, sourcePath: ref.sourcePath }
          })
        }
      }
    }

    // In VS Code webview environment, skip Ajv validation to comply with CSP
    const g: any = (typeof globalThis !== 'undefined') ? (globalThis as any) : {}
    if (g && (g.acquireVsCodeApi || (g.__GTS_APP_API__ && (g.__GTS_APP_API__.type === 'vscode' || g.__GTS_APP_API__.disableValidation === true)))) {
      return
    }

    if (entity instanceof JsonSchema) {
      // Validate the schema itself (meta-validation)
      try {
        const ajv = this.createAjvInstance()
        // Try to compile the schema to check if it's valid (async to support $ref resolution)
        await ajv.compileAsync(entity.content)
      } catch (error: any) {
        // If Ajv provides a detailed errors array, use it for precise paths
        if (Array.isArray(error?.errors) && error.errors.length > 0) {
          const detailed = this.formatValidationErrors(error.errors)
          // Prefix message to indicate schema invalid, but keep per-error granularity
          detailed.forEach((e) => {
            e.keyword = e.keyword || 'schema'
            e.message = e.message || 'Invalid JSON Schema'
          })
          entity.validation.errors.push(...detailed)
        } else {
          // Fallback: try to extract a path from error.message like "data/xxx ..."
          const msg: string = String(error?.message || 'Unknown schema error')
          const m = msg.match(/data(\/[A-Za-z0-9_\-\.\[\]\/]+)\b/)
          const instancePath = m ? m[1] : ''
          entity.validation.errors.push({
            instancePath,
            schemaPath: '#',
            keyword: 'schema',
            message: `Invalid JSON Schema: ${msg}`,
            params: { error: msg }
          })
        }
      }
    } else if (entity instanceof JsonObj) {
      // Validate the object against its schema
      if (!entity.schemaId) {
        // No schema to validate against
        return
      }

      const schema = this.resolveSchema(entity.schemaId)
      if (!schema) {
        // Prefer pointing to the field that produced schemaId
        const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
        const instancePath = '/' + String(idField)
        entity.validation.errors.push({
          instancePath,
          schemaPath: '#',
          keyword: 'schema',
          message: `Schema not found: ${entity.schemaId}`,
          params: { schemaId: entity.schemaId }
        })
        return
      }

      try {
        const ajv = this.createAjvInstance()

        // Compile the schema with async $ref resolution
        const validate = await ajv.compileAsync(schema.content)

        const valid = validate(entity.content) as boolean

        // Merge AJV errors with previously collected GTS reference errors
        if (!valid && validate.errors) {
          const formatted = this.formatValidationErrors(validate.errors)
          entity.validation.errors.push(...formatted)
        }
      } catch (error: any) {
        entity.validation.errors.push({
          instancePath: '',
          schemaPath: '#',
          keyword: 'validation',
          message: `Validation error: ${error.message}`,
          params: { error: error.message }
        })
      }
    }
  }

  /**
   * Validate all entities in the registry.
   * First validates all schemas, then validates all objects against their schemas.
   */
  async validateEntities(): Promise<void> {
    // Validate schemas first
    for (const schema of this.jsonSchemas.values()) {
      await this.validateEntity(schema)
    }

    // Then validate objects against their schemas
    for (const obj of this.jsonObjs.values()) {
      await this.validateEntity(obj)
    }
  }

  /**
   * Format Ajv error objects into detailed ValidationError objects
   */
  private formatValidationErrors(ajvErrors: ErrorObject[]): ValidationError[] {
    return ajvErrors.map((err: ErrorObject) => {
      const instancePath = err.instancePath || '/'
      const schemaPath = err.schemaPath || '#'

      // Create a detailed error message based on the keyword
      let detailedMessage = err.message || 'Validation failed'

      // Add more context based on the error type
      if (err.keyword === 'type') {
        const expected = err.params.type
        detailedMessage = `must be ${expected}`
      } else if (err.keyword === 'required') {
        const missing = err.params.missingProperty
        detailedMessage = `missing required property '${missing}'`
      } else if (err.keyword === 'additionalProperties') {
        const extra = err.params.additionalProperty
        detailedMessage = `must NOT have additional property '${extra}'`
      } else if (err.keyword === 'pattern') {
        const pattern = err.params.pattern
        detailedMessage = `must match pattern "${pattern}"`
      } else if (err.keyword === 'enum') {
        const allowed = err.params.allowedValues
        detailedMessage = `must be one of: ${JSON.stringify(allowed)}`
      } else if (err.keyword === 'minimum' || err.keyword === 'maximum') {
        const limit = err.params.limit
        const comparison = err.params.comparison
        detailedMessage = `must be ${comparison} ${limit}`
      } else if (err.keyword === 'minLength' || err.keyword === 'maxLength') {
        const limit = err.params.limit
        detailedMessage = `${err.message}`
      } else if (err.keyword === 'minItems' || err.keyword === 'maxItems') {
        const limit = err.params.limit
        detailedMessage = `must ${err.keyword === 'minItems' ? 'NOT' : ''} have ${err.keyword === 'minItems' ? 'fewer' : 'more'} than ${limit} items`
      } else if (err.keyword === 'anyOf' || err.keyword === 'oneOf' || err.keyword === 'allOf') {
        detailedMessage = `must match ${err.keyword} schema`
      } else if (err.keyword === 'format') {
        const format = err.params.format
        detailedMessage = `must match format "${format}"`
      }

      return {
        instancePath,
        schemaPath,
        keyword: err.keyword,
        message: detailedMessage,
        params: err.params || {},
        data: err.data
      }
    })
  }

  /**
   * Create an Ajv instance with custom schema resolver.
   * This resolver handles GTS ID references and supports all JSON Schema features.
   */
  private createAjvInstance(): Ajv {
    const registry = this

    const ajv = new Ajv({
      strict: false,
      allErrors: true,
      verbose: true,
      // Enable full JSON Schema support
      discriminator: true,
      allowUnionTypes: true,
      // Provide data alongside errors
      $data: true,
      // Disable code generation for CSP compliance (VS Code webviews)
      code: { source: false },
      // Custom schema loader for GTS ID resolution
      loadSchema: async (uri: string): Promise<any> => {
        const schemaId = decodeGtsId(uri)

        // Allow standard JSON Schema references
        if (schemaId.startsWith('https://json-schema.org') || schemaId.startsWith('http://json-schema.org')) {
          return true
        }

        // This is called by Ajv when it encounters a $ref it can't resolve
        const schema = registry.resolveSchema(schemaId)
        if (!schema) {
          // Show human-readable error message with decoded URI
          throw new Error(`Schema not found for $ref: ${schemaId}`)
        }
        return schema.content
      }
    })

    // Add format validation (email, uri, date-time, etc.)
    addFormats(ajv)

    // Add custom schema loader that resolves GTS IDs from the registry
    ajv.addKeyword({
      keyword: 'gtsRef',
      schemaType: 'string',
    })

    return ajv
  }

  /**
   * Retrieve a schema using its ID. File path resolution is
   * deliberately omitted to maintain service integrity.
   * Utilized by the Ajv validator for resolving $ref references.
   */
  private resolveSchema(schemaId: string): JsonSchema | undefined {
    // Attempt to find schema directly in the registry using the decoded ID
    return this.jsonSchemas.get(schemaId)
  }

  /**
   * Set the default file path to use when opening the layout.
   */
  setDefaultFile(pathOrNull: string | null | undefined): void {
    if (pathOrNull) {
      this.defaultFilePath = pathOrNull
    } else {
      this.defaultFilePath = this.jsonFiles.values().next().value?.path || null
    }
  }

  /**
   * Get the default file path, if set.
   */
  getDefaultFilePath(): string | null {
    return this.defaultFilePath || null
  }

  /**
   * Get the default JsonFile, if any.
   */
  getDefaultFile(): JsonFile | undefined {
    const p = this.defaultFilePath
    if (!p) return undefined
    return this.jsonFiles.get(p)
  }

  /**
   * Ingest files that have already been loaded into memory.
   * This is the primary method for applications to populate the registry.
   *
   * @param files - Array of {path, name, content} objects
   * @param cfg - GTS configuration for entity ID extraction
   */
  async ingestFiles(files: Array<{ path: string; name: string; content: any }>, cfg: GtsConfig): Promise<void> {
    cfg = getGtsConfig(cfg)
    for (const file of files) {
      try {
        // Skip files in the .gts-viewer directory (cross-platform, browser-safe)
        if (/(^|[\\\/])\.gts-viewer[\\\/]/.test(file.path)) {
          continue
        }
        this.processFileContent(file.path, file.name, file.content, cfg)
      } catch (error) {
        console.error(`Failed to process file ${file.path}:`, error)
      }
    }
    await this.validateEntities()
  }
}

export function isGtsCandidateFileName(fileName: string): boolean {
  return fileName.endsWith('.json') || fileName.endsWith('.jsonc') || fileName.endsWith('.gts') || fileName.endsWith('.yaml') || fileName.endsWith('.yml') || fileName.endsWith('.tsp')
}
