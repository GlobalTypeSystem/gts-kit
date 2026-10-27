import { JsonFile, JsonObj, JsonSchema, createEntity, getGtsConfig, decodeGtsId, createAbsentEntity, normalizeGtsId, findGtsPrefixViolations } from './entities.js'
import type { GtsConfig, JsonEntity, ValidationResult, ValidationError } from './entities.js'
import { isYamlFileName } from './parse.js'
import { findSchemaPropertyPath, findXGtsRefPath, findTraitRequiredPath, findRegexPatternPath, getInstanceFieldSubschema } from './schemaParser.js'
import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import { GtsModifiers, GtsStore, GtsRefValidationMode, createJsonEntity, GTS_REF_KEYWORDS, X_GTS_TYPE_REF, X_GTS_INSTANCE_REF, X_GTS_PATTERN_REF } from '@globaltypesystem/gts-ts'
// XGtsRefValidator is not re-exported from the package index, so import it from
// its published subpath module.
import { XGtsRefValidator } from '@globaltypesystem/gts-ts/dist/x-gts-ref.js'
import type { Format } from 'ajv'
import * as path from 'path'

const JSON_SCHEMA_ANNOTATION_KEYWORDS = new Set([
  '$comment',
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
  'contentEncoding',
  'contentMediaType',
  'contentSchema'
])

/**
 * A gts-ts GtsStore holding the registry's winning entity for each id, plus
 * what registering them reported.
 */
class GtsStoreMirror {
  readonly store = new GtsStore()
  // Modifier-declaration errors captured while registering schemas into the
  // gts-ts store (register() throws these per §9.11.1), keyed by schema id.
  readonly declErrors = new Map<string, string>()
  // Registry id -> id the entity is registered under in the store, so a
  // removed/replaced entity can be unregistered without re-extracting its id.
  private readonly storeIds = new Map<string, string>()
  // Ids matching a wildcard pattern, valid until the store's entity set changes.
  private readonly matchCache = new Map<string, string[]>()

  constructor() {
    // gts-ts resolves a wildcard reference operand by testing every registered
    // id under the pattern's literal prefix, on every validation that reaches
    // it; with `gts.x.*`-style operands and 100K+ entities that dominated
    // workspace validation. The result only depends on the registered ids, and
    // this mirror performs every mutation of the store, so it is memoized here
    // until the next add/remove. (Private gts-ts method: if it is renamed, the
    // store simply runs unmemoized.)
    const store = this.store as unknown as { matchingIds?: (pattern: string) => string[] }
    const matchingIds = store.matchingIds
    if (typeof matchingIds !== 'function') return
    store.matchingIds = (pattern: string) => {
      let ids = this.matchCache.get(pattern)
      if (!ids) {
        ids = matchingIds.call(this.store, pattern)
        this.matchCache.set(pattern, ids)
      }
      return ids
    }
  }

  /** Register `entity`, replacing whatever was registered for its id. */
  add(entity: JsonEntity): void {
    this.matchCache.clear()
    this.remove(entity.id)
    const storeEntity = createJsonEntity(entity.content)
    try {
      this.store.register(storeEntity)
      this.storeIds.set(entity.id, storeEntity.id)
    } catch (err) {
      // A schema register() rejects (§9.11.1 declaration error) is reported by
      // validateEntity; an instance that can't be registered (e.g. malformed or
      // UUID-less id) is reported through the normal instance-validation path.
      if (entity instanceof JsonSchema) {
        this.declErrors.set(entity.id, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** Unregister whatever is registered for registry id `id`. */
  remove(id: string): void {
    this.declErrors.delete(id)
    const storeId = this.storeIds.get(id)
    if (storeId === undefined) return
    this.storeIds.delete(id)
    this.matchCache.clear()
    this.store.unregister(storeId)
  }
}

/** True when two file contents (parsed values, or raw text for unparsable files) are identical. */
function sameFileContent(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a === 'string' || typeof b === 'string') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** The reference keywords whose values name concrete entities (§9.6.1). */
const ENTITY_REF_KEYWORDS = [X_GTS_TYPE_REF, X_GTS_INSTANCE_REF]

/** True for the GTS reference keywords (`x-gts-type-ref`, `x-gts-instance-ref`, `x-gts-pattern-ref`). */
function isGtsRefKeyword(key: string): boolean {
  return (GTS_REF_KEYWORDS as readonly string[]).includes(key)
}

/** True when `schema` declares any GTS reference keyword. */
function hasGtsRefKeyword(schema: any): boolean {
  return GTS_REF_KEYWORDS.some(key => schema[key] !== undefined)
}

/**
 * Prepare a schema for Ajv instance validation by removing the GTS reference
 * keywords (`x-gts-type-ref`, `x-gts-instance-ref`, `x-gts-pattern-ref`) and
 * pruning combinator branches that were reference-keyword-only.
 *
 * This matters for combinators: a branch like `{ "x-gts-type-ref": "…" }` becomes an
 * empty schema once the keyword is dropped, i.e. always-true. Left in place, an
 * `oneOf` of two such branches matches *both* and Ajv spuriously reports
 * "must match exactly one schema in oneOf" for a value that is perfectly valid.
 * The actual reference assertions — including correct oneOf/anyOf branch
 * counting — are enforced separately by the gts-ts store (§9.6).
 *
 * Unlike gts-ts's full `normalizeSchema`, this intentionally does NOT rewrite
 * `$id`/`$ref` (it leaves any `gts://` prefixes untouched) because the
 * registry's Ajv instance resolves those via its own `gts://`-aware loader.
 */
function stripGtsRefKeywordsForAjv(schema: any): any {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(stripGtsRefKeywordsForAjv)

  const normalized: Record<string, any> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (isGtsRefKeyword(key)) continue
    normalized[key] = value && typeof value === 'object' ? stripGtsRefKeywordsForAjv(value) : value
  }

  // Drop combinator subschemas whose only assertion was a reference keyword, so Ajv
  // doesn't treat their remaining annotations as always-true branches.
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (!Array.isArray(normalized[combinator])) continue
    normalized[combinator] = normalized[combinator].filter((_sub: any, idx: number) => {
      const original = (schema as any)[combinator]?.[idx]
      const hasOnlyXGtsRefAssertion =
        original &&
        typeof original === 'object' &&
        !Array.isArray(original) &&
        hasGtsRefKeyword(original) &&
        Object.keys(original).every(key => isGtsRefKeyword(key) || JSON_SCHEMA_ANNOTATION_KEYWORDS.has(key))
      return !hasOnlyXGtsRefAssertion
    })
    if (normalized[combinator].length === 0) delete normalized[combinator]
  }

  return normalized
}

/**
 * Evaluate one of `ajv-formats`' standard `Format` definitions against a string.
 * A `Format` may be a `RegExp`, a validator function, or a
 * `{ validate }` object whose `validate` is again a regex or a function.
 */
function matchesFormat(format: Format, value: string): boolean {
  if (format instanceof RegExp) return format.test(value)
  // The `Format` union also covers async/number variants; the temporal string
  // formats we compose here are synchronous, so narrow the callable/regex forms.
  const def = format as { validate?: RegExp | ((v: string) => boolean) } | ((v: string) => boolean)
  const validate = typeof def === 'function' ? def : def?.validate
  if (validate instanceof RegExp) return validate.test(value)
  if (typeof validate === 'function') return Boolean(validate(value))
  return false
}

/** Ajv configured for GTS: the options, formats and keywords every instance shares. */
function createGtsAjv(options: { validateSchema?: boolean; loadSchema?: (uri: string) => Promise<any> } = {}): Ajv {
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
    ...options
  })

  // Add format validation (email, uri, date-time, etc.). Default "full" mode
  // validates real value ranges (e.g. rejects month 13, offset +25:00).
  addFormats(ajv)

  // Tighten the temporal formats to strict RFC 3339. ajv-formats' full-mode
  // date/time splits on `/t|\s/i`, so it accepts a space instead of `T`
  // (permitted by RFC 3339 §5.6's NOTE, but not by the ABNF grammar GTS
  // requires). Compose the two *standard* ajv-formats validators so a value
  // must satisfy BOTH: the "fast" grammar (strict `T` separator + mandatory
  // time-offset) AND the "full" validator (real calendar/clock ranges).
  for (const name of ['date', 'time', 'date-time'] as const) {
    const fast = addFormats.get(name, 'fast')
    const full = addFormats.get(name, 'full')
    ajv.addFormat(name, {
      type: 'string',
      validate: (value: string) => matchesFormat(fast, value) && matchesFormat(full, value),
    })
  }

  // GTS id formats emitted by schema generators (e.g. gts-rust) as annotations
  // next to an `x-gts-type-ref`/`x-gts-instance-ref` that does the actual checking. Registered as
  // accept-all — exactly how Ajv treated them before (ignored as unknown) —
  // so each compile no longer logs an "unknown format" warning.
  // Same for the sized-integer formats Rust's schemars emits (int32/int64 are
  // already provided by ajv-formats).
  for (const name of ['gts-instance-id', 'gts-type-id', 'int8', 'int16', 'uint', 'uint8', 'uint16', 'uint32', 'uint64']) {
    ajv.addFormat(name, true)
  }

  // Add custom schema loader that resolves GTS IDs from the registry
  ajv.addKeyword({
    keyword: 'gtsRef',
    schemaType: 'string',
  })

  return ajv
}

// Meta-schema validation depends only on the Ajv options, never on the
// registry, so one instance — whose meta-schemas are compiled once — serves
// every schema. Each schema still compiles in its own fresh instance, and that
// instance used to compile the draft-07 meta-schema from scratch first: ~80% of
// all validation time, minutes on a workspace with 100K+ schemas.
let sharedMetaValidator: Ajv | null = null

/** True for the json-schema.org URIs the registry's schema loader resolves to `true` (accept-all). */
function isStandardJsonSchemaUri(uri: string): boolean {
  const id = decodeGtsId(uri)
  return id.startsWith('https://json-schema.org') || id.startsWith('http://json-schema.org')
}

/**
 * Meta-validate `schema` exactly as Ajv does before adding it to an instance,
 * but against the shared meta-schemas; throws Ajv's own "schema is invalid"
 * error. Returns false, without validating, when the schema names a `$schema`
 * that only the per-instance loader can resolve.
 */
function metaValidateShared(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return true
  const ajv = (sharedMetaValidator ??= createGtsAjv())
  const $schema = schema.$schema
  if ($schema !== undefined) {
    if (typeof $schema !== 'string') return false
    let known: boolean
    try {
      known = Boolean(ajv.getSchema($schema))
    } catch {
      return false
    }
    // Any other json-schema.org meta-schema (e.g. draft 2020-12, which plain
    // Ajv doesn't bundle) is loaded as `true`, so the schema is valid against it.
    if (!known) return isStandardJsonSchemaUri($schema)
  }
  if (!ajv.validateSchema(schema)) throw new Error(`schema is invalid: ${ajv.errorsText(ajv.errors)}`)
  return true
}

/**
 * A meta-validated schema without its `$schema`, so the instance compiling it
 * doesn't load and compile that meta-schema again. `$schema` has no other
 * effect on compilation.
 */
function withoutMetaSchemaRef(schema: any): any {
  if (!schema || typeof schema !== 'object' || !('$schema' in schema)) return schema
  const { $schema: _metaSchema, ...rest } = schema
  return rest
}

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
 * True when a resolved subschema describes a *scalar data value* rather than a
 * GTS reference: it constrains the value with a scalar `type`, a `format`, an
 * `enum`, or a `const`, and does NOT declare it as a reference via a GTS reference keyword
 * or `$ref`. Used to suppress the syntactic "GTS reference not found" check for
 * fields whose GTS-id-shaped value is just data (e.g. a `format: uuid` string).
 */
function isScalarDataField(sub: any): boolean {
  if (!sub || typeof sub !== 'object') return false
  if (hasGtsRefKeyword(sub) || sub['$ref'] !== undefined) return false
  const scalarTypes = new Set(['string', 'number', 'integer', 'boolean', 'null'])
  const t = sub.type
  const hasScalarType = typeof t === 'string'
    ? scalarTypes.has(t)
    : Array.isArray(t) && t.length > 0 && t.every((x: any) => scalarTypes.has(x))
  return hasScalarType || sub.format !== undefined || sub.enum !== undefined || sub.const !== undefined
}

/**
 * Reverse-dependency graph, split by how a change propagates.
 *
 * `structural.get(id)` — entity ids whose *effective schema* incorporates `id`
 *   (derivation, multi-level derivation, instantiation, `$ref`/`allOf`). A change
 *   to `id` changes their meaning, so this relation is followed **transitively**.
 *
 * `references.get(id)` — entity ids that merely *point at* `id` by GTS id (any
 *   GTS id field, `x-gts-type-ref`/`x-gts-instance-ref`). They must be re-checked when `id` changes/renames,
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

  // Lazily-built gts-ts store mirroring the registry's schemas and instances,
  // used to delegate GTS-specific schema validation (derivation §9.12, traits
  // OP#13, modifier declaration/placement §9.11) that plain Ajv cannot
  // express. Once built it is kept in sync as entities are indexed/removed.
  private gtsMirror: GtsStoreMirror | null = null

  // Cached reverse-dependency graph used by getDependentFilePaths(). Rebuilt
  // lazily and invalidated whenever the entity set changes (any indexFile /
  // invalidateFile / reset). See buildDependencyGraph() for the edge model.
  private depGraph: DependencyGraph | null = null

  // Bumped on every change to the indexed content (index/invalidate/reset).
  // Validation results and compiled validators are only reused within one
  // generation, because an entity's result depends on the rest of the registry
  // ($ref targets, parent schemas, referenced ids).
  private contentGeneration = 0
  // Per-entity validation result for the current generation. Shared by
  // concurrent callers, and lets a pass validate each entity once instead of
  // re-validating the whole parent chain for every derived schema.
  private validationMemo = new WeakMap<
    JsonEntity,
    { generation: number; result: Promise<ValidationResult>; settled?: ValidationResult }
  >()
  // Compiled Ajv validators for instance validation, keyed by the (winning)
  // schema's content object. Each gets its own Ajv instance, exactly as before,
  // but is compiled once per generation instead of once per instance.
  private instanceValidators: { generation: number; byContent: Map<object, Promise<ValidateFunction>> } =
    { generation: -1, byContent: new Map() }

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
    this.contentGeneration++
  }

  /** Drop the cached gts-ts store so it is rebuilt from current schemas on next use. */
  private invalidateGtsStore(): void {
    this.gtsMirror = null
  }

  /**
   * Build (once, then cache) a gts-ts GtsStore mirroring every schema *and
   * instance* currently in the registry, so both ancestor-chain-dependent
   * schema checks (derivation, traits, final/abstract guards) and instance
   * checks (`validateInstance`) can be delegated to the reference
   * implementation instead of being re-derived here. Modifier-declaration
   * errors that gts-ts throws when registering a schema are captured per id
   * rather than aborting the whole build; instances that fail to register are
   * skipped (they surface through the normal instance-validation path).
   */
  private getGtsMirror(): GtsStoreMirror {
    if (!this.gtsMirror) {
      const mirror = new GtsStoreMirror()
      for (const schema of this.jsonSchemas.values()) mirror.add(schema)
      for (const obj of this.jsonObjs.values()) mirror.add(obj)
      this.gtsMirror = mirror
    }
    return this.gtsMirror
  }

  private getGtsStore(): GtsStore {
    return this.getGtsMirror().store
  }

  /**
   * Build the gts-ts store ahead of validation, calling `tick` between
   * entities so the caller can yield: built on demand, it blocks for seconds
   * on a workspace with 100K+ entities. The store is only adopted when the
   * registry didn't change while it was being built.
   */
  async prepareGtsStore(tick: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 2 && !this.gtsMirror; attempt++) {
      const generation = this.contentGeneration
      const mirror = new GtsStoreMirror()
      for (const entities of [Array.from(this.jsonSchemas.values()), Array.from(this.jsonObjs.values())]) {
        for (const entity of entities) {
          mirror.add(entity)
          await tick()
        }
      }
      if (!this.gtsMirror && this.contentGeneration === generation) this.gtsMirror = mirror
    }
  }

  /**
   * Mirror a newly winning entity (the one `jsonSchemas`/`jsonObjs` now hold
   * for its id) into the gts-ts store, if it has been built. Updating it in
   * place instead of dropping it matters on large workspaces: rebuilding it
   * re-registers every entity, which took seconds and ran on every edit.
   */
  private addToGtsStore(entity: JsonEntity): void {
    this.gtsMirror?.add(entity)
  }

  /** Drop the entity registered for registry id `id` from the gts-ts store, if any. */
  private removeFromGtsStore(id: string): void {
    this.gtsMirror?.remove(id)
  }

  /** Record that the indexed content changed: derived caches and memoized results are stale. */
  private markContentChanged(): void {
    this.depGraph = null
    this.contentGeneration++
  }

  /**
   * Invalidate a file and remove its JsonFile and associated records from the registry.
   * Returns false (and leaves every cache intact) when nothing was indexed for it.
   */
  invalidateFile(path: string): boolean {
    const objs = this.jsonFileObjs.get(path)
    const schemas = this.jsonFileSchemas.get(path)
    const hadRecords = this.jsonFiles.has(path) || this.invalidFiles.has(path) || !!objs?.length || !!schemas?.length
    if (!hadRecords) return false
    // Any entity set change invalidates the reverse-dependency graph (rebuilt
    // lazily) and every memoized validation result; the gts-ts store is
    // updated in place.
    this.markContentChanged()
    this.jsonFiles.delete(path)
    this.invalidFiles.delete(path)
    if (objs) {
      for (const obj of objs) {
        this.jsonObjs.delete(obj.id)
        this.removeFromGtsStore(obj.id)
      }
      this.jsonFileObjs.delete(path)
      this.jsonFileObjs.set(path, [])
    }
    if (schemas) {
      for (const schema of schemas) {
        this.jsonSchemas.delete(schema.id)
        this.removeFromGtsStore(schema.id)
      }
      this.jsonFileSchemas.delete(path)
      this.jsonFileSchemas.set(path, [])
    }
    return true
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
   *      which already includes entity-reference targets (their concrete values
   *      are valid GTS ids). Wildcard reference *patterns* are authoring
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
   * Recursively collect GTS entity definitions embedded inline under any nested
   * `entities:` array within a parsed (YAML) document. This supports config
   * files that seed GTS types/instances inline — e.g. a service's
   * `types-registry.config.entities` block — where each array element is a full
   * JSON Schema / instance keyed by its own `$id`.
   *
   * The returned contents are handed to the normal entity pipeline
   * (`createEntity` + `isGtsEntity`), so non-GTS `entities` entries are filtered
   * out naturally and only genuine definitions are registered.
   */
  private static collectInlineEntityDefinitions(root: any): any[] {
    const out: any[] = []
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'entities' && Array.isArray(value)) {
          for (const el of value) {
            if (el && typeof el === 'object' && !Array.isArray(el)) out.push(el)
          }
        }
        visit(value)
      }
    }
    visit(root)
    return out
  }

  /**
   * Process a file and store its entities if they are GTS entities.
   * This is a helper used by both scanFile and ingestFiles.
   */
  private processFileContent(path: string, name: string, content: any, cfg: GtsConfig): boolean {
    // Re-indexing identical content (opening a file, saving without changes,
    // revalidating open documents) must not count as a change: a change throws
    // away every memoized validation result and compiled validator.
    const previous = this.jsonFiles.get(path) ?? this.invalidFiles.get(path)
    if (previous && previous.name === name && sameFileContent(previous.content, content)) return false

    // Cleanup any existing records for this file
    let changed = this.invalidateFile(path)

    // Create JsonFile
    const jsonFile = new JsonFile(path, name, content)

    // Track if we found any GTS entities in this file
    let hasGtsEntities = false

    if (jsonFile.validation && jsonFile.validation.errors.length > 0) {
      // Store JsonFile if it's invalid to show it in the UI
      this.invalidFiles.set(path, jsonFile)
      this.markContentChanged()
      return true
    }

    // Use the file's parsed content: JsonFile parses raw string input (JSON/JSONC
    // or YAML, by extension) in its constructor, so this is an object/array even
    // when a raw string was passed in.
    const parsedContent = jsonFile.content

    // Register one entity content as a schema/instance if it is a GTS entity.
    const registerEntity = (entityContent: any, seq: number | undefined, requireSelectedId = false) => {
      const entity = createEntity({ file: jsonFile, listSequence: seq, content: entityContent, cfg })
      const hasSelectedId = entity?.selectedEntityIdField !== undefined || entity?.selectedSchemaIdField !== undefined
      if (entity && (!requireSelectedId || hasSelectedId) && entity.isGtsEntity()) {
        hasGtsEntities = true
        if (!changed) {
          this.markContentChanged()
          changed = true
        }
        if (entity instanceof JsonSchema) {
          this.jsonSchemas.set(entity.id, entity)
          this.jsonFileSchemas.set(path, [...this.jsonFileSchemas.get(path) || [], entity])
        } else {
          this.jsonObjs.set(entity.id, entity as JsonObj)
          this.jsonFileObjs.set(path, [...this.jsonFileObjs.get(path) || [], entity as JsonObj])
        }
        this.addToGtsStore(entity)
      }
    }

    // Top level: a single entity, or a top-level array of entities. This is the
    // only shape recognized for JSON/JSONC/.gts files.
    const entities = normalizeToArray(parsedContent)
    entities.forEach((entityContent: any, idx: number) => {
      registerEntity(entityContent, Array.isArray(parsedContent) ? idx : undefined, isYamlFileName(name))
    })

    // YAML ONLY: config files may additionally *define* GTS types/instances
    // inline under nested `entities:` arrays (e.g. a types-registry
    // `config.entities` seed block), possibly buried several levels deep inside
    // otherwise-non-GTS config. Register each such element as a real definition
    // so its `$id` is treated as a definition instead of being harvested as a
    // dangling reference. JSON files intentionally keep the strict shape above.
    if (isYamlFileName(name)) {
      for (const def of JsonRegistry.collectInlineEntityDefinitions(parsedContent)) {
        registerEntity(def, undefined)
      }
    }

    // Only store the JsonFile once if it contains GTS entities
    if (hasGtsEntities && !this.jsonFiles.has(path)) {
      this.jsonFiles.set(path, jsonFile)
    }
    return changed
  }

  /**
   * Index a single file's entities into the registry (no validation).
   *
   * This is the incremental counterpart to ingestFiles: it upserts one file's
   * entities without re-processing the whole workspace and without running Ajv.
   * Use it to keep a long-lived registry in sync with editor/file changes.
   * Returns whether the indexed state changed (false for identical content).
   */
  indexFile(path: string, name: string, content: any, cfg: GtsConfig): boolean {
    // Skip files in the .gts-viewer directory (cross-platform, browser-safe)
    if (/(^|[\\\/])\.gts-viewer[\\\/]/.test(path)) {
      return false
    }
    try {
      return this.processFileContent(path, name, content, getGtsConfig(cfg))
    } catch (error) {
      console.error(`Failed to index file ${path}:`, error)
      return true
    }
  }

  /**
   * Validate a single entity against its schema.
   *
   * The result is built locally and published with a single assignment. The
   * computation awaits (Ajv compileAsync, parent validation), so two overlapping
   * validations of the same entity (e.g. an open-document check racing a
   * workspace pass) used to reset and append to the shared `entity.validation`
   * in interleaved order, duplicating or dropping errors.
   */
  async validateEntity(entity: JsonEntity): Promise<void> {
    const generation = this.contentGeneration
    let memo = this.validationMemo.get(entity)
    if (!memo || memo.generation !== generation) {
      const result = this.computeEntityValidation(entity)
      memo = { generation, result }
      this.validationMemo.set(entity, memo)
      // Don't cache a failure: let the next call retry.
      const current = memo
      result.catch(() => { if (this.validationMemo.get(entity) === current) this.validationMemo.delete(entity) })
    }
    const validation = await memo.result
    // A newer computation (registry changed meanwhile) owns the published result.
    if (this.validationMemo.get(entity) === memo) {
      memo.settled = validation
      entity.validation = validation
    }
  }

  /**
   * Validation result of an entity that an instance references through an
   * entity-reference field, evaluated within the chain of instances being validated
   * (`chain`). Returns null for a reference cycle, which is treated as valid
   * (like gts-ts's visiting guard).
   *
   * Schemas are validated normally: a schema's result never depends on an
   * instance, so waiting on it can't form a cycle. Instances can reference
   * each other, so an instance is never waited on while its validation is in
   * progress elsewhere (that could deadlock on a cycle); unless a finished
   * result for the current generation exists it is recomputed within `chain`,
   * and not cached, since a cut cycle can make that result differ from the
   * entity's standalone one.
   */
  private async referencedEntityValidation(
    dependency: JsonEntity,
    chain: ReadonlySet<JsonEntity>
  ): Promise<ValidationResult | null> {
    if (dependency instanceof JsonSchema) {
      await this.validateEntity(dependency)
      return dependency.validation ?? null
    }
    if (chain.has(dependency)) return null
    const memo = this.validationMemo.get(dependency)
    if (memo && memo.generation === this.contentGeneration && memo.settled) return memo.settled
    return this.computeEntityValidation(dependency, new Set(chain).add(dependency))
  }

  /**
   * Compiled validator for instance validation against `schemaContent`, reused
   * across instances within the current content generation.
   */
  private getInstanceValidator(schemaContent: object): Promise<ValidateFunction> {
    if (this.instanceValidators.generation !== this.contentGeneration) {
      this.instanceValidators = { generation: this.contentGeneration, byContent: new Map() }
    }
    const cache = this.instanceValidators.byContent
    let validator = cache.get(schemaContent)
    if (!validator) {
      // Strip the reference keywords first so Ajv never sees them and,
      // crucially, so reference-only combinator branches don't collapse into
      // always-true schemas and make e.g.
      // `oneOf: [{x-gts-type-ref}, {x-gts-instance-ref}]` fail. The reference
      // assertions themselves are enforced by the gts-ts store.
      validator = this.compileSchema(stripGtsRefKeywordsForAjv(schemaContent))
      cache.set(schemaContent, validator)
      validator.catch(() => { if (cache.get(schemaContent) === validator) cache.delete(schemaContent) })
    }
    return validator
  }

  private async computeEntityValidation(
    entity: JsonEntity,
    chain: ReadonlySet<JsonEntity> = new Set([entity])
  ): Promise<ValidationResult> {
    const validation: ValidationResult = { errors: [] }

    // Enforce gts:// URI-prefix rules: the prefix is required in JSON Schema URL
    // fields ($id, $ref, x-gts-traits-schema) and forbidden everywhere else.
    for (const violation of findGtsPrefixViolations(entity.content)) {
      const instancePath = violation.sourcePath === 'root'
        ? '/'
        : '/' + violation.sourcePath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
      validation.errors.push({
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
      // For an instance, resolve its schema so we can tell a genuine GTS
      // reference field apart from a scalar data value that merely *looks* like
      // a GTS id (e.g. a `format: uuid` string). References are harvested
      // syntactically (any GTS-id-shaped string, regardless of field), so
      // without this a value like "gts.x…v1~<uuid>" in a plain typed field
      // would be wrongly reported as a missing reference. Only instances carry
      // a separate schema to consult; schema-shaped entities keep prior behaviour.
      const instanceSchema = (entity instanceof JsonObj && entity.schemaId)
        ? this.resolveSchema(entity.schemaId)?.content ?? null
        : null
      // Configured GTS id/schema fields (id, gtsIid, type, $schema, ...) are
      // references by definition and must keep being checked even when a schema
      // types them as a plain `string`; only *other* scalar-typed fields are
      // exempted below.
      const cfg = getGtsConfig(undefined)
      const idFieldNames = new Set([...cfg.entity_id_fields, ...cfg.schema_id_fields])

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

        // In a schema, an `x-gts-pattern-ref` operand only constrains what
        // values look like (§9.6: it names no entity, and gts-ts never looks it
        // up), and `x-gts-traits` values are trait data, checked against the
        // trait schema by gts-ts. Neither has to exist. (`x-gts-type-ref` /
        // `x-gts-instance-ref` operands are checked by gts-ts as well.)
        const segments = ref.sourcePath.replace(/\[\d+\]/g, '').split('.')
        if (entity instanceof JsonSchema && (segments[segments.length - 1] === X_GTS_PATTERN_REF || segments.includes('x-gts-traits'))) {
          continue
        }

        // Schema-aware skip: when the instance's schema types this field as a
        // scalar data value (a `format`/scalar `type`/`enum`/`const`, and NOT a
        // reference via a reference keyword/`$ref`), its GTS-id-shaped value is data,
        // not a reference, so its existence must not be checked. Configured
        // id/schema fields are never exempted (they are references by design).
        const lastSegment = ref.sourcePath.replace(/\[\d+\]/g, '').split('.').pop() || ''
        if (
          instanceSchema &&
          !idFieldNames.has(lastSegment) &&
          isScalarDataField(getInstanceFieldSubschema(instanceSchema, ref.sourcePath))
        ) {
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
          validation.errors.push({
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
      return validation
    }

    if (entity instanceof JsonSchema) {
      // Validate the schema itself (meta-validation)
      try {
        // Try to compile the schema to check if it's valid (async to support $ref resolution)
        await this.compileSchema(entity.content)
      } catch (error: any) {
        // If Ajv provides a detailed errors array, use it for precise paths
        if (Array.isArray(error?.errors) && error.errors.length > 0) {
          const detailed = this.formatValidationErrors(error.errors)
          // Prefix message to indicate schema invalid, but keep per-error granularity
          detailed.forEach((e) => {
            e.keyword = e.keyword || 'schema'
            e.message = e.message || 'Invalid JSON Schema'
          })
          validation.errors.push(...detailed)
        } else {
          // Fallback: try to extract a path from error.message like "data/xxx ..."
          const msg: string = String(error?.message || 'Unknown schema error')
          const m = msg.match(/data(\/[A-Za-z0-9_\-\.\[\]\/]+)\b/)
          const instancePath = m ? m[1] : ''
          validation.errors.push({
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
      const { store, declErrors } = this.getGtsMirror()
      const declError = declErrors.get(entity.id)
      if (declError) {
        // register() rejected this schema outright (§9.11.1); surface it and
        // skip chain validation (the schema isn't in the store).
        validation.errors.push({
          instancePath: '',
          schemaPath: '#',
          keyword: 'x-gts-schema',
          message: declError,
          params: {}
        })
      } else {
        const result = store.validateSchemaAgainstParent(entity.id)
        if (!result.ok && result.error) {
          const rawMessages = result.error.split('; ')
          for (const msg of rawMessages) {
            const propMatch = msg.match(/^Property '([^']+)'/)
            const propPath = propMatch ? propMatch[1] : null
            // A "Referenced type '<id>' is invalid: ..." / "<path> names '<id>',
            // which is invalid: ..." message is caused by a specific reference
            // node, not by the schema's own `$id`; anchor it to that node so the
            // squiggle lands on the ref (e.g. line with `"x-gts-type-ref": "<id>"`)
            // rather than the document root. Everything else keeps the previous
            // `$id` fallback.
            const refMatch = propPath ? null : msg.match(/^Referenced (?:type|entity) '([^']+)' is invalid| names '([^']+)', which is invalid/)
            const refId = refMatch ? refMatch[1] ?? refMatch[2] : null
            // A "trait validation: ..." message comes from the OP#13 trait
            // completeness check; anchor it to the unmet `x-gts-traits-schema`
            // requirement (the specific `required` entry when we can name the
            // missing trait) instead of the schema's `$id`.
            const isTraitError = !propPath && !refMatch && msg.startsWith('trait validation:')
            // A regex that can't be compiled (e.g. "failed to compile trait
            // schema: Unsupported pattern /.../: ..."): anchor it to the
            // offending `pattern` / `patternProperties` entry, when it is in
            // this document, instead of the schema's `$id`.
            const regexPath = !propPath && !refMatch && !isTraitError && /regular expression|Unsupported pattern/.test(msg)
              ? findRegexPatternPath(entity.content, msg)
              : null
            // The keyword-placement/unknown-keyword guards (§9.11, §9.7.1) report
            // the offending keyword's JSON path(s) inline as "… found at: a/b/c,
            // d/e/f". Anchor the diagnostic to the first such path so the squiggle
            // lands on the actual keyword (e.g. properties/subject_type/x-gts-type-ref)
            // instead of the schema's `$id` — and so a self-referencing reference keyword
            // elsewhere no longer appears to "own" an error from another field.
            const foundAtMatch = !propPath && !refMatch && !isTraitError && !regexPath
              ? msg.match(/ found at: (.+)$/)
              : null
            let instancePath: string | null = null
            let params: Record<string, any> = {}
            if (propPath) {
              instancePath = findSchemaPropertyPath(entity.content, propPath)
              params = { property: propPath }
            } else if (refMatch) {
              instancePath = findXGtsRefPath(entity.content, refId!)
              params = { refValue: refId }
            } else if (isTraitError) {
              const traitMatch = msg.match(/required (?:property|trait) '([^']+)'/)
              const traitName = traitMatch ? traitMatch[1] : undefined
              instancePath = findTraitRequiredPath(entity.content, traitName)
              params = traitName ? { trait: traitName } : {}
            } else if (regexPath) {
              instancePath = regexPath
            } else if (foundAtMatch) {
              // The reported path uses `/` separators and `[n]` array indices
              // (e.g. "allOf[0]/properties/x/x-gts-type-ref"); the depth-guard also
              // appends " (nesting exceeds …)" which is not part of the path.
              const firstPath = foundAtMatch[1].split(', ')[0].replace(/ \(.*\)$/, '').trim()
              instancePath = fieldPathToInstancePath(firstPath)
              params = { keywordPath: firstPath }
            }
            validation.errors.push({
              instancePath: instancePath || '/$id',
              schemaPath: '#',
              keyword: 'x-gts-schema',
              message: msg,
              params
            })
          }
        }
      }

      // §9.6.3: validate the reference keyword *operands* inside the schema
      // (e.g. a literal that is neither a valid GTS ID/pattern nor `/$id`). This checks the schema authoring, not an instance value.
      const refDeclErrors = new XGtsRefValidator().validateSchema(entity.content)
      for (const err of refDeclErrors) {
        validation.errors.push({
          instancePath: fieldPathToInstancePath(err.fieldPath),
          schemaPath: '#',
          keyword: err.keyword ?? 'x-gts-schema',
          message: err.reason,
          params: { value: err.value, refPattern: err.refPattern }
        })
      }

      if (validation.errors.length === 0) {
        const ancestors = JsonRegistry.ancestorTypeIds(entity.id)
        const parentId = ancestors.length > 1 ? ancestors[ancestors.length - 2] : null
        const parent = parentId ? this.jsonSchemas.get(parentId) : undefined
        if (parent) {
          await this.validateEntity(parent)
          if (parent.validation?.errors.length) {
            validation.errors.push({
              instancePath: '/$id',
              schemaPath: '#',
              keyword: 'x-gts-schema',
              message: `Parent schema '${parentId}' has GTS validation errors`,
              params: { schemaId: parentId }
            })
          }
        }
      }
    } else if (entity instanceof JsonObj) {
      // Validate the object against its schema
      if (!entity.schemaId) {
        const store = this.getGtsStore()
        const result = store.validateInstance(entity.id)
        if (!result.ok) {
          const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
          validation.errors.push({
            instancePath: '/' + String(idField),
            schemaPath: '#',
            keyword: 'schema',
            message: result.error,
            params: { gtsId: entity.id }
          })
        }
        return validation
      }

      const schema = this.resolveSchema(entity.schemaId)
      if (!schema) {
        // Prefer pointing to the field that produced schemaId
        const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
        const instancePath = '/' + String(idField)
        validation.errors.push({
          instancePath,
          schemaPath: '#',
          keyword: 'schema',
          message: `Schema not found: ${entity.schemaId}`,
          params: { schemaId: entity.schemaId }
        })
        return validation
      }

      // An instance of an invalid type is itself invalid (as gts-ts's
      // store.validateInstance reports it). The type's own result already
      // includes its ancestor chain ("Parent schema ... has GTS validation
      // errors"), so a broken ancestor reaches the instance too. Validation
      // results are memoized per registry generation, so this is a cache hit
      // during a workspace pass.
      await this.validateEntity(schema)
      const typeErrors = schema.validation?.errors || []
      if (typeErrors.length > 0) {
        const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
        validation.errors.push({
          instancePath: '/' + String(idField),
          schemaPath: '#',
          keyword: 'x-gts-schema',
          message: `Instance type '${entity.schemaId}' is invalid: ${typeErrors[0].message}`,
          params: { schemaId: entity.schemaId }
        })
      }

      // §9.11.3 (OP#6): an instance's rightmost type must be instantiable. A
      // type marked `x-gts-abstract: true` is a template and MUST NOT be
      // instantiated directly. Ajv has no notion of this keyword, so enforce it
      // explicitly here (mirrors gts-ts store.validateInstance).
      if (GtsModifiers.isAbstract(schema.content)) {
        const idField = (entity as any).selectedSchemaIdField || (entity as any).selectedEntityIdField || 'id'
        validation.errors.push({
          instancePath: '/' + String(idField),
          schemaPath: '#',
          keyword: 'x-gts-abstract',
          message: `Type '${entity.schemaId}' is abstract and cannot be directly instantiated`,
          params: { schemaId: entity.schemaId }
        })
      }

      try {
        // Compiled with async $ref resolution, once per schema per generation.
        const validate = await this.getInstanceValidator(schema.content)

        const valid = validate(entity.content) as boolean

        // Merge AJV errors with previously collected GTS reference errors
        if (!valid && validate.errors) {
          const formatted = this.formatValidationErrors(validate.errors)
          validation.errors.push(...formatted)
        }

        // §9.6: the reference keywords are assertions on instance string values
        // (the value must be a GTS ID matching the declared prefix/pattern).
        // Ajv treats them as unknown keywords and silently ignores them, so they are
        // enforced explicitly here (mirrors gts-ts store.validateInstance).
        // Since gts-ts 0.11 XGtsRefValidator is registry-less, so the check is
        // delegated to the registry's gts-ts store, which follows `gts://`
        // `$ref`s into parent schemas. It runs in any-present mode (the
        // any-valid check is done below); only reference-keyword issues are
        // kept (Ajv already reported the rest), and "not found" errors repeat
        // the gtsRefs registry check above and are dropped.
        const store = this.getGtsStore()
        const storeResult = store.get(entity.id)
          ? store.validateInstance(entity.id, GtsRefValidationMode.AnyPresent)
          : null
        for (const issue of storeResult?.errors ?? []) {
          if (!issue.keyword.startsWith('x-gts-')) continue
          if (/not found/.test(issue.message)) continue
          validation.errors.push({
            instancePath: issue.instancePath,
            schemaPath: issue.schemaPath || '#',
            keyword: issue.keyword,
            message: issue.message,
            params: issue.params
          })
        }

        // §9.6 `gts-ref-validation=any-valid` (the spec's default policy): an
        // entity referenced through an entity-reference field must itself be valid,
        // transitively, or the referencing instance is invalid too.
        const checkedIds = new Set<string>()
        for (const { id: referencedId, sourcePath } of entity.gtsRefs ?? []) {
          if (checkedIds.has(referencedId)) continue
          const fieldSchema = getInstanceFieldSubschema(schema.content, sourcePath)
          const keyword = ENTITY_REF_KEYWORDS.find(key => fieldSchema?.[key] !== undefined)
          if (!keyword) continue
          checkedIds.add(referencedId)
          const dependency = this.jsonObjs.get(referencedId) ?? this.jsonSchemas.get(referencedId)
          if (!dependency || dependency === entity) continue
          const dependencyValidation = await this.referencedEntityValidation(dependency, chain)
          const firstError = dependencyValidation?.errors[0]
          if (!firstError) continue
          validation.errors.push({
            instancePath: sourcePath && sourcePath !== 'root'
              ? '/' + sourcePath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
              : '/',
            schemaPath: '#',
            keyword,
            message: `Referenced entity '${referencedId}' is invalid: ${firstError.message}`,
            params: { value: referencedId }
          })
        }
      } catch (error: any) {
        validation.errors.push({
          instancePath: '',
          schemaPath: '#',
          keyword: 'validation',
          message: `Validation error: ${error.message}`,
          params: { error: error.message }
        })
      }
    }
    return validation
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
   * Compile `schema` with an Ajv instance that resolves GTS `$ref`s from the
   * registry. Rejects exactly like `compileAsync` did when each fresh instance
   * meta-validated schemas itself, but the meta-validation runs against the
   * shared, compiled-once meta-schemas (see metaValidateShared). Schemas naming
   * a `$schema` the shared instance doesn't know keep the full per-instance path.
   */
  private async compileSchema(schema: any): Promise<ValidateFunction> {
    if (!metaValidateShared(schema)) return this.createAjvInstance(false).compileAsync(schema)
    return this.createAjvInstance(true).compileAsync(withoutMetaSchemaRef(schema))
  }

  /**
   * Create an Ajv instance with custom schema resolver.
   * This resolver handles GTS ID references and supports all JSON Schema features.
   *
   * With `sharedMeta`, the instance doesn't meta-validate schemas itself: the
   * caller validated the root (compileSchema) and the loader validates every
   * schema it loads, both against the shared meta-schemas.
   */
  private createAjvInstance(sharedMeta: boolean): Ajv {
    const registry = this

    return createGtsAjv({
      validateSchema: !sharedMeta,
      // Custom schema loader for GTS ID resolution
      loadSchema: async (uri: string): Promise<any> => {
        const schemaId = decodeGtsId(uri)

        // Allow standard JSON Schema references
        if (isStandardJsonSchemaUri(uri)) {
          return true
        }

        // This is called by Ajv when it encounters a $ref it can't resolve
        const schema = registry.resolveSchema(schemaId)
        if (!schema) {
          // Show human-readable error message with decoded URI
          throw new Error(`Schema not found for $ref: ${schemaId}`)
        }
        if (sharedMeta && metaValidateShared(schema.content)) return withoutMetaSchemaRef(schema.content)
        return schema.content
      }
    })
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
