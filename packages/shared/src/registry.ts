import { JsonFile, JsonObj, JsonSchema, createEntity, getGtsConfig, decodeGtsId } from './entities.js'
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
    this.defaultFilePath = null
  }

  reset(): void {
    this.jsonObjs.clear()
    this.jsonSchemas.clear()
    this.jsonFiles.clear()
    this.invalidFiles.clear()
    this.fetchCache.clear()
    this.defaultFilePath = null
  }

  /**
   * Fetch JSON with centralized caching. Path can be repo-relative or absolute; we normalize to leading '/'.
   */
  async fetchJson(path: string, force = false): Promise<any> {
    const key = path.startsWith('/') ? path : `/${path}`
    if (!force && this.fetchCache.has(key)) return this.fetchCache.get(key)!
    const p = (async () => {
      const res = await fetch(key)
      if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`)
      return res.json()
    })()
    this.fetchCache.set(key, p)
    return p
  }

  /**
   * Read a JSON file and upsert its JsonFile record in the registry.
   */
  async upsertFileFromPath(path: string, force = false): Promise<JsonFile> {
    const content = await this.fetchJson(path, force)
    const name = path.split('/').pop() || path
    const file: JsonFile = new JsonFile(path, name, content)
    this.jsonFiles.set(path, file)
    return file
  }

  /**
   * Process a file and store its entities if they are GTS entities.
   * This is a helper used by both scanFile and ingestFiles.
   */
  private processFileContent(path: string, name: string, content: any, cfg: GtsConfig): void {
    // Create JsonFile
    const jsonFile = new JsonFile(path, name, content)

    // Track if we found any GTS entities in this file
    let hasGtsEntities = false

    if (jsonFile.validation && !jsonFile.validation.valid) {
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
        } else {
          this.jsonObjs.set(entity.id, entity as JsonObj)
        }
      }
    })

    // Only store the JsonFile once if it contains GTS entities
    if (hasGtsEntities && !this.jsonFiles.has(path)) {
      this.jsonFiles.set(path, jsonFile)
    }
  }

  /**
   * Scan a single file and add its GTS entities to the registry.
   * Returns true if the file was successfully processed.
   */
  async scanFile(path: string, cfg: GtsConfig): Promise<boolean> {
    try {
      // Ensure file is JSON by checking extension
      if (!isGtsCandidateFileName(path)) {
        return false
      }

      const content = await this.fetchJson(path)
      const name = path.split('/').pop() || path

      this.processFileContent(path, name, content, cfg)
      return true
    } catch (error) {
      console.error(`Failed to scan file ${path}:`, error)
      return false
    }
  }

  /**
   * Validate a single entity against its schema.
   */
  async validateEntity(entity: JsonEntity): Promise<void> {
    // Initialize validation result
    entity.validation = { valid: true, errors: [] }

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
        entity.validation.valid = true
      } catch (error: any) {
        entity.validation.valid = false
        entity.validation.errors.push({
          instancePath: '',
          schemaPath: '#',
          keyword: 'schema',
          message: `Invalid JSON Schema: ${error.message}`,
          params: { error: error.message }
        })
      }
    } else if (entity instanceof JsonObj) {
      // Validate the object against its schema
      if (!entity.schemaId) {
        // No schema to validate against
        return
      }

      const schema = this.resolveSchema(entity.schemaId)
      if (!schema) {
        entity.validation.valid = false
        entity.validation.errors.push({
          instancePath: '',
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

        entity.validation.valid = valid
        if (!valid && validate.errors) {
          entity.validation.errors = this.formatValidationErrors(validate.errors)
        }
      } catch (error: any) {
        entity.validation.valid = false
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
  return fileName.endsWith('.json') || fileName.endsWith('.jsonc') || fileName.endsWith('.gts')
}
