import { JsonFile, JsonObj, JsonSchema, createEntity, getGtsConfig, decodeGtsId, createAbsentEntity, normalizeGtsId, findGtsPrefixViolations } from './entities.js'
import type { GtsConfig, JsonEntity, ValidationResult, ValidationError } from './entities.js'
import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import { GtsModifiers, GtsStore, createJsonEntity } from '@globaltypesystem/gts-ts'
// XGtsRefValidator is not re-exported from the package index, so import it from
// its published subpath module.
import { XGtsRefValidator } from '@globaltypesystem/gts-ts/dist/x-gts-ref.js'
import * as path from 'path'

/**
 * Convert an XGtsRefValidator field path (dot/bracket notation, e.g.
 * `value.tags[0]`) into a JSON-Pointer-style instancePath (`/value/tags/0`)
 * matching the shape produced elsewhere in this file.
 */
function fieldPathToInstancePath(fieldPath: string): string {
  if (!fieldPath || fieldPath === '/') return '/'
  return '/' + fieldPath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
}

/**
 * Helper to normalize content to array for processing
 */
function normalizeToArray(content: any): any[] {
  return Array.isArray(content) ? content : [content]
}

/**
 * Reverse-dependency graph, split by how a change propagates.
 *
 * `structural.get(id)` — entity ids whose *effective schema* incorporates `id`
 *   (derivation, multi-level derivation, instantiation, `$ref`/`allOf`). A change
 *   to `id` changes their meaning, so this relation is followed **transitively**.
 *
 * `references.get(id)` — entity ids that merely *point at* `id` by GTS id (any
 *   GTS id field, `x-gts-ref`). They must be re-checked when `id` changes/renames,
 *   but their own shape is unaffected, so this relation is applied **depth-1**.
 */
interface DependencyGraph {
  structural: Map<string, Set<string>>
  references: Map<string, Set<string>>
}

/**
 * Outcome of handling a single file change (see JsonRegistry.applyFileChange /
 * revalidateAfterChange). All paths are the entity file paths that were
 * revalidated in the registry so callers can refresh exactly those.
 */
export interface RevalidationResult {
  /** The file that changed. */
  changedPath: string
  /** Files whose entities depend on the changed file and were revalidated. */
  dependentPaths: Set<string>
  /** All revalidated paths (the changed file, if still present, plus dependents). */
  revalidatedPaths: string[]
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

  // Lazily-built gts-ts store mirroring the registry's schemas, used to
  // delegate GTS-specific schema validation (derivation §9.12, traits OP#13,
  // modifier declaration/placement §9.11) that plain Ajv cannot express. It is
  // invalidated whenever schemas change and rebuilt on next demand.
  private gtsStore: GtsStore | null = null
  // Modifier-declaration errors captured while registering schemas into the
  // gts-ts store (register() throws these per §9.11.1), keyed by schema id.
  private gtsStoreDeclErrors: Map<string, string> = new Map()

  // Cached reverse-dependency graph used by getDependentFilePaths(). Rebuilt
  // lazily and invalidated whenever the entity set changes (any indexFile /
  // invalidateFile / reset). See buildDependencyGraph() for the edge model.
  private depGraph: DependencyGraph | null = null

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
    this.invalidateGtsStore()
    this.depGraph = null
  }

  /** Drop the cached gts-ts store so it is rebuilt from current schemas on next use. */
  private invalidateGtsStore(): void {
    this.gtsStore = null
    this.gtsStoreDeclErrors.clear()
  }

  /**
   * Build (once, then cache) a gts-ts GtsStore mirroring every schema currently
   * in the registry, so ancestor-chain-dependent checks (derivation, traits,
   * final/abstract guards) can be delegated to the reference implementation.
   * Modifier-declaration errors that gts-ts throws at registration time are
   * captured per schema id rather than aborting the whole build.
   */
  private getGtsStore(): GtsStore {
    if (this.gtsStore) return this.gtsStore
    const store = new GtsStore()
    this.gtsStoreDeclErrors.clear()
    for (const schema of this.jsonSchemas.values()) {
      try {
        store.register(createJsonEntity(schema.content))
      } catch (err) {
        this.gtsStoreDeclErrors.set(schema.id, err instanceof Error ? err.message : String(err))
      }
    }
    this.gtsStore = store
    return store
  }

  /**
   * Invalidate a file and remove its JsonFile and associated records from the registry.
   */
  invalidateFile(path: string): void {
    // Any schema set change invalidates the derived gts-ts store and the
    // reverse-dependency graph (both are rebuilt lazily on next use).
    this.invalidateGtsStore()
    this.depGraph = null
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
   * Cumulative `~`-terminated prefixes of a GTS id — its ancestor *type* chain.
   *
   * GTS encodes derivation directly in the id: a type id and every derived type
   * appended after it are separated by `~`. So for
   * `gts.a.b.c.d.v1~k.l.m.n.v1~` the ancestor type ids are
   * `gts.a.b.c.d.v1~` (the base) and `gts.a.b.c.d.v1~k.l.m.n.v1~` (the full id).
   * This is how single-level derivation, multi-level derivation and
   * instantiation are all reduced to one relation: "does this id's type chain
   * contain the changed type id?".
   */
  private static ancestorTypeIds(id: string): string[] {
    const out: string[] = []
    if (!id) return out
    let idx = id.indexOf('~')
    while (idx !== -1) {
      out.push(id.slice(0, idx + 1))
      idx = id.indexOf('~', idx + 1)
    }
    return out
  }

  /** All entity ids currently defined in the given file (schemas + instances). */
  getEntityIdsForFile(path: string): string[] {
    const ids: string[] = []
    for (const s of this.jsonFileSchemas.get(path) || []) ids.push(s.id)
    for (const o of this.jsonFileObjs.get(path) || []) ids.push(o.id)
    return ids
  }

  /**
   * Build (once, then cache) the reverse-dependency graph. See DependencyGraph
   * for the two edge kinds and how each propagates. Edges recorded per entity:
   *
   *  structural (transitive — Type #1 schema dependency):
   *    - derivation / multi-level derivation: a schema whose own id has the
   *      target in its ancestor type chain (id prefix at `~` boundaries)
   *    - instantiation: an instance whose `schemaId` chain contains the target
   *      (its direct type and every base of that type)
   *    - `$ref` / `allOf` / ...: a schema whose JSON-Schema refs point at target
   *      (JsonSchema.schemaRefs)
   *
   *  references (depth-1 — Type #2 id reference):
   *    - any GTS id used anywhere in the entity's content (JsonEntity.gtsRefs),
   *      which already includes `x-gts-ref` targets (their concrete values are
   *      valid GTS ids). Wildcard `x-gts-ref` *patterns* are authoring
   *      constraints; the concrete instance value that matches carries the real
   *      id edge via gtsRefs, so patterns need no separate reverse edge.
   */
  private buildDependencyGraph(): DependencyGraph {
    if (this.depGraph) return this.depGraph

    const structural = new Map<string, Set<string>>()
    const references = new Map<string, Set<string>>()
    const link = (map: Map<string, Set<string>>, target: string, dependent: string) => {
      if (!target || !dependent || target === dependent) return
      let set = map.get(target)
      if (!set) { set = new Set<string>(); map.set(target, set) }
      set.add(dependent)
    }

    const addEntity = (entity: JsonEntity, isSchema: boolean) => {
      const eid = entity.id
      if (!eid) return

      // Structural: derivation & instantiation via the type chain. Schemas
      // derive from their proper ancestors (exclude their own full id); an
      // instance depends on every type in its schemaId chain (incl. direct type).
      const chainSource = isSchema ? eid : (entity.schemaId || '')
      for (const ancestor of JsonRegistry.ancestorTypeIds(chainSource)) {
        if (isSchema && ancestor === eid) continue
        link(structural, ancestor, eid)
      }
      // Structural: JSON-Schema $ref / allOf composition (schemas only).
      if (isSchema) {
        const schemaRefs = (entity as JsonSchema).schemaRefs
        if (schemaRefs) for (const ref of schemaRefs) link(structural, ref.id, eid)
      }

      // References (depth-1): every GTS id the entity points at.
      if (entity.gtsRefs) {
        for (const ref of entity.gtsRefs) link(references, ref.id, eid)
      }
    }

    for (const schema of this.jsonSchemas.values()) addEntity(schema, true)
    for (const obj of this.jsonObjs.values()) addEntity(obj, false)

    this.depGraph = { structural, references }
    return this.depGraph
  }

  /**
   * Return the set of file paths (excluding `changedPath`) whose entities must be
   * revalidated when `changedPath` changes.
   *
   * Two relations are combined (see DependencyGraph):
   *   1. structural dependents are followed **transitively** (a derived type's
   *      own dependents are affected too);
   *   2. plain id-reference dependents of the changed (seed) ids are added
   *      **depth-1**. A structural descendant's *shape* may change, but a plain
   *      id reference only checks its target's existence/id — which is unchanged
   *      — so references are not propagated through the structural closure.
   *
   * The structural walk is breadth-first guarded by a `visited` set, so
   * derivation can never cycle and reference cycles (schema A `$ref`s B and B
   * `$ref`s A) terminate.
   *
   * `extraSeedIds` lets callers add ids that existed *before* an edit (captured
   * prior to reindexing) so that renaming/removing an id still revalidates the
   * files that referenced its old id.
   */
  getDependentFilePaths(changedPath: string, extraSeedIds?: Iterable<string>): Set<string> {
    const paths = new Set<string>()

    const seedIds = new Set<string>(this.getEntityIdsForFile(changedPath))
    if (extraSeedIds) for (const id of extraSeedIds) if (id) seedIds.add(id)
    if (seedIds.size === 0) return paths

    const { structural, references } = this.buildDependencyGraph()

    const addFile = (entityId: string) => {
      const filePath = this.jsonSchemas.get(entityId)?.file?.path
        || this.jsonObjs.get(entityId)?.file?.path
      if (filePath && filePath !== changedPath) paths.add(filePath)
    }

    // 1. Transitive structural closure over the changed ids. `visited` guards
    //    the BFS against cycles (reference-induced or otherwise).
    const visited = new Set<string>(seedIds)
    const queue = [...seedIds]
    while (queue.length > 0) {
      const current = queue.shift()!
      const dependents = structural.get(current)
      if (!dependents) continue
      for (const dependent of dependents) {
        if (visited.has(dependent)) continue
        visited.add(dependent)
        queue.push(dependent)
        addFile(dependent)
      }
    }

    // 2. Depth-1 id-reference dependents of the changed (seed) ids only.
    for (const id of seedIds) {
      const referrers = references.get(id)
      if (!referrers) continue
      for (const referrer of referrers) addFile(referrer)
    }

    return paths
  }

  /**
   * Validate every entity currently indexed for `path` (schemas first, then
   * instances) against the current registry context. Files that failed to parse
   * already carry their error on the JsonFile in `invalidFiles`, so they are
   * skipped here.
   */
  async validateFile(path: string): Promise<void> {
    if (this.invalidFiles.has(path)) return
    for (const schema of this.jsonFileSchemas.get(path) || []) {
      await this.validateEntity(schema)
    }
    for (const obj of this.jsonFileObjs.get(path) || []) {
      await this.validateEntity(obj)
    }
  }

  /**
   * Revalidate `changedPath` and every file that (transitively/­referentially)
   * depends on it. Assumes the changed file's new content is *already indexed*
   * (via `indexFile`/`invalidateFile`). `previousIds` should carry the ids the
   * file defined before the edit so a rename/removal still revalidates the files
   * that referenced the old id.
   *
   * Returns the affected file paths (the changed file, when it still holds
   * entities, plus all dependents) so callers can refresh their UI/markers.
   */
  async revalidateAfterChange(
    changedPath: string,
    previousIds?: Iterable<string>
  ): Promise<RevalidationResult> {
    const dependents = this.getDependentFilePaths(changedPath, previousIds)

    const revalidatedPaths: string[] = []
    const changedStillPresent = this.jsonFiles.has(changedPath) || this.invalidFiles.has(changedPath)
    if (changedStillPresent) {
      await this.validateFile(changedPath)
      revalidatedPaths.push(changedPath)
    }
    for (const dependentPath of dependents) {
      await this.validateFile(dependentPath)
      revalidatedPaths.push(dependentPath)
    }

    return { changedPath, dependentPaths: dependents, revalidatedPaths }
  }

  /**
   * End-to-end handler for a single file change, shared by every app (Web,
   * Electron, VS Code) so revalidation behaves identically everywhere:
   *   1. snapshot the file's previous entity ids (for rename/removal),
   *   2. (re)index the new `content` — or drop the file when `content` is
   *      null/undefined (deletion),
   *   3. revalidate the changed file and all of its dependents.
   */
  async applyFileChange(
    path: string,
    name: string,
    content: any,
    cfg: GtsConfig = getGtsConfig(undefined)
  ): Promise<RevalidationResult> {
    const previousIds = this.getEntityIdsForFile(path)
    if (content === null || content === undefined) {
      this.invalidateFile(path)
    } else {
      this.indexFile(path, name, content, cfg)
    }
    return this.revalidateAfterChange(path, previousIds)
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

    // Use the file's parsed content: JsonFile parses raw string input (JSON/JSONC
    // or YAML, by extension) in its constructor, so this is an object/array even
    // when a raw string was passed in.
    const parsedContent = jsonFile.content

    // Normalize content to array and process each entity
    const entities = normalizeToArray(parsedContent)
    entities.forEach((entityContent: any, idx: number) => {
      const seq = Array.isArray(parsedContent) ? idx : undefined
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
   * Index a single file's entities into the registry (no validation).
   *
   * This is the incremental counterpart to ingestFiles: it upserts one file's
   * entities without re-processing the whole workspace and without running Ajv.
   * Use it to keep a long-lived registry in sync with editor/file changes.
   */
  indexFile(path: string, name: string, content: any, cfg: GtsConfig): void {
    // Skip files in the .gts-viewer directory (cross-platform, browser-safe)
    if (/(^|[\\\/])\.gts-viewer[\\\/]/.test(path)) {
      return
    }
    try {
      this.processFileContent(path, name, content, getGtsConfig(cfg))
    } catch (error) {
      console.error(`Failed to index file ${path}:`, error)
    }
  }

  /**
   * Validate a single entity against its schema.
   */
  async validateEntity(entity: JsonEntity): Promise<void> {
    // Initialize validation result
    entity.validation = { errors: [] }

    // Enforce gts:// URI-prefix rules: the prefix is required in JSON Schema URL
    // fields ($id, $ref, x-gts-traits-schema) and forbidden everywhere else.
    for (const violation of findGtsPrefixViolations(entity.content)) {
      const instancePath = violation.sourcePath === 'root'
        ? '/'
        : '/' + violation.sourcePath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
      entity.validation.errors.push({
        instancePath,
        schemaPath: '#',
        keyword: 'gts-uri-prefix',
        message: violation.issue.message,
        params: {
          fieldName: violation.fieldName,
          value: violation.rawValue,
          suggestion: violation.issue.suggestion,
          kind: violation.issue.kind
        }
      })
    }

    // Check if all GTS references exist in the registry
    if (entity.gtsRefs && entity.gtsRefs.length > 0) {
      for (const ref of entity.gtsRefs) {
        // Skip reference validation for refs inside /examples field in schemas
        // Match 'examples' at root or after array indices (e.g., allOf[0].examples), but NOT after 'properties'
        // Valid: 'examples', 'examples[0]', 'allOf[0].examples', 'anyOf[1].examples[0]'
        // Invalid: 'properties.examples' (this is a regular schema property, not documentation examples)
        const isInExamples = /(?:^|(?:allOf|anyOf|oneOf)\[\d+\]\.)examples(?:\[|$|\.)/.test(ref.sourcePath) ||
                            /^examples(?:\[|$|\.)/.test(ref.sourcePath)
        
        if (isInExamples) {
          continue
        }
        
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

      // GTS Type Schema rules that plain JSON Schema meta-validation cannot
      // express, delegated to the gts-ts reference implementation:
      //   - §9.11.1 invalid modifier declaration (final+abstract, non-boolean)
      //   - §9.11 misplaced document-level keywords + final-base-in-chain guard
      //   - §9.12 (OP#12) derivation constraint compatibility with the parent
      //   - §9.7  (OP#13) trait schema/value validation across the chain
      const store = this.getGtsStore()
      const declError = this.gtsStoreDeclErrors.get(entity.id)
      if (declError) {
        // register() rejected this schema outright (§9.11.1); surface it and
        // skip chain validation (the schema isn't in the store).
        entity.validation.errors.push({
          instancePath: '',
          schemaPath: '#',
          keyword: 'x-gts-schema',
          message: declError,
          params: {}
        })
      } else {
        const result = store.validateSchemaAgainstParent(entity.id)
        if (!result.ok && result.error) {
          entity.validation.errors.push({
            instancePath: '',
            schemaPath: '#',
            keyword: 'x-gts-schema',
            message: result.error,
            params: {}
          })
        }
      }

      // §9.6: validate the `x-gts-ref` *pattern declarations* inside the schema
      // (e.g. a literal that is neither a valid GTS ID/pattern nor a resolvable
      // JSON Pointer). This checks the schema authoring, not an instance value.
      const refDeclErrors = new XGtsRefValidator().validateSchema(entity.content)
      for (const err of refDeclErrors) {
        entity.validation.errors.push({
          instancePath: fieldPathToInstancePath(err.fieldPath),
          schemaPath: '#',
          keyword: 'x-gts-ref',
          message: err.reason,
          params: { value: err.value, refPattern: err.refPattern }
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

      // §9.11.3 (OP#6): an instance's rightmost type must be instantiable. A
      // type marked `x-gts-abstract: true` is a template and MUST NOT be
      // instantiated directly. Ajv has no notion of this keyword, so enforce it
      // explicitly here (mirrors gts-ts store.validateInstance).
      if (GtsModifiers.isAbstract(schema.content)) {
        const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
        entity.validation.errors.push({
          instancePath: '/' + String(idField),
          schemaPath: '#',
          keyword: 'x-gts-abstract',
          message: `Type '${entity.schemaId}' is abstract and cannot be directly instantiated`,
          params: { schemaId: entity.schemaId }
        })
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

        // §9.6: `x-gts-ref` is an assertion keyword on instance string values
        // (the value must be a GTS ID matching the declared prefix/pattern).
        // Ajv treats it as an unknown keyword and silently ignores it, so it is
        // enforced explicitly here (mirrors gts-ts store.validateInstance).
        // No store is passed: referenced-entity existence is already covered by
        // the gtsRefs registry check above, so this validator only enforces the
        // GTS-ID format and the prefix/pattern constraint.
        const xGtsRefErrors = new XGtsRefValidator().validateInstance(entity.content, schema.content)
        for (const err of xGtsRefErrors) {
          entity.validation.errors.push({
            instancePath: fieldPathToInstancePath(err.fieldPath),
            schemaPath: '#',
            keyword: 'x-gts-ref',
            message: err.reason,
            params: { value: err.value, refPattern: err.refPattern }
          })
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
   * Normalizes the ID to strip gts:// prefix (per GTS spec).
   */
  private resolveSchema(schemaId: string): JsonSchema | undefined {
    // Normalize the schema ID by stripping gts:// prefix (per GTS spec)
    const normalizedId = normalizeGtsId(schemaId)
    // Attempt to find schema directly in the registry using the normalized ID
    return this.jsonSchemas.get(normalizedId)
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
   * @param options - Optional flags. Set `skipValidation` to only index entities
   *   (id/type/file) without running Ajv schema validation. This is much cheaper
   *   and is used on latency-sensitive paths such as editor decorations.
   */
  async ingestFiles(
    files: Array<{ path: string; name: string; content: any }>,
    cfg: GtsConfig,
    options?: { skipValidation?: boolean }
  ): Promise<void> {
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
    if (!options?.skipValidation) {
      await this.validateEntities()
    }
  }
}

export function isGtsCandidateFileName(fileName: string): boolean {
  return fileName.endsWith('.json') || fileName.endsWith('.jsonc') || fileName.endsWith('.gts') || fileName.endsWith('.yaml') || fileName.endsWith('.yml')
}
