import { JsonRegistry, DEFAULT_GTS_CONFIG } from '@gts/shared'
import type { GtsConfig } from '@gts/shared'
import { findMalformedGtsIds, type MalformedGtsId } from './gtsIdFormat'
import { TimeSlicer } from './timeSlice'

/**
 * Long-lived, shared GTS registry for the extension host.
 *
 * The registry is indexed *without* Ajv validation (id / schema-vs-instance /
 * file only), which is all the decoration, link and hover providers need. It is
 * built once from a full workspace scan and then kept in sync incrementally as
 * individual files change, so we never re-parse the whole workspace on the
 * latency-sensitive open/typing paths.
 *
 * Ajv schema validation is done on demand, per document, in validation.ts using
 * this same registry as the resolution context.
 */

export interface RegistryFileInput {
  path: string
  name: string
  content: any
}

let registry: JsonRegistry | null = null
let activeConfig: GtsConfig = DEFAULT_GTS_CONFIG
let revision = 0
// Malformed GTS ids per file, kept in lockstep with the registry so closed files
// report them too (the registry itself only indexes *valid* GTS entities, so a
// file whose only GTS content is malformed would otherwise not exist for us).
const malformedIdsByPath = new Map<string, MalformedGtsId[]>()

const GTS_VIEWER_DIR_RE = /(^|[\\/])\.gts-viewer[\\/]/

function findMalformedIdsIn(path: string, content: any): MalformedGtsId[] {
  // Unparsable files (raw string content) are reported as parse errors instead.
  return typeof content === 'string' || GTS_VIEWER_DIR_RE.test(path) ? [] : findMalformedGtsIds(content)
}

function updateMalformedIds(path: string, content: any): void {
  const issues = findMalformedIdsIn(path, content)
  if (issues.length > 0) malformedIdsByPath.set(path, issues)
  else malformedIdsByPath.delete(path)
}

/** Malformed GTS ids found in a file's current indexed content. */
export function getMalformedIds(path: string): readonly MalformedGtsId[] {
  return malformedIdsByPath.get(path) || []
}

/** Every indexed file that contains at least one malformed GTS id. */
export function getPathsWithMalformedIds(): string[] {
  return [...malformedIdsByPath.keys()]
}

/** Get the shared registry, or null if it hasn't been built yet. */
export function getRegistry(): JsonRegistry | null {
  return registry
}

export function getRegistryRevision(): number {
  return revision
}

/**
 * Rebuild the shared registry from a full set of scanned files (index-only).
 * Indexing 100K+ files takes seconds, so it yields between time slices (via
 * `slicer`, which also aborts a cancelled scan by throwing); the shared
 * registry is only replaced once the new one is complete.
 */
export async function rebuildRegistry(
  files: RegistryFileInput[],
  cfg: GtsConfig = DEFAULT_GTS_CONFIG,
  slicer: TimeSlicer = new TimeSlicer()
): Promise<JsonRegistry> {
  const next = new JsonRegistry()
  const malformed = new Map<string, MalformedGtsId[]>()
  for (const file of files) {
    next.indexFile(file.path, file.name, file.content, cfg)
    const issues = findMalformedIdsIn(file.path, file.content)
    if (issues.length > 0) malformed.set(file.path, issues)
    await slicer.tick()
  }
  activeConfig = cfg
  malformedIdsByPath.clear()
  for (const [path, issues] of malformed) malformedIdsByPath.set(path, issues)
  registry = next
  revision++
  return next
}

/** Incrementally upsert a single file's entities into the shared registry. Returns whether anything changed. */
export function indexFile(path: string, name: string, content: any): boolean {
  if (!registry) return false
  const changed = registry.indexFile(path, name, content, activeConfig)
  updateMalformedIds(path, content)
  if (changed) revision++
  return changed
}

/** `indexFile` for many files, yielding between time slices. Returns the paths whose indexed state changed. */
export async function indexFiles(files: RegistryFileInput[], slicer: TimeSlicer = new TimeSlicer()): Promise<string[]> {
  const changed: string[] = []
  for (const file of files) {
    if (indexFile(file.path, file.name, file.content)) changed.push(file.path)
    await slicer.tick()
  }
  return changed
}

/** Remove a single file's entities from the shared registry. */
export function removeFile(path: string): void {
  if (!registry) return
  const changed = registry.invalidateFile(path)
  if (malformedIdsByPath.delete(path) || changed) revision++
}

/** The GTS config the registry was built with. */
export function getActiveConfig(): GtsConfig {
  return activeConfig
}
