import { JsonRegistry, DEFAULT_GTS_CONFIG } from '@gts/shared'
import type { GtsConfig } from '@gts/shared'

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

let registry: JsonRegistry | null = null
let activeConfig: GtsConfig = DEFAULT_GTS_CONFIG

/** Get the shared registry, or null if it hasn't been built yet. */
export function getRegistry(): JsonRegistry | null {
  return registry
}

/** Rebuild the shared registry from a full set of scanned files (index-only). */
export async function rebuildRegistry(
  files: Array<{ path: string; name: string; content: any }>,
  cfg: GtsConfig = DEFAULT_GTS_CONFIG
): Promise<JsonRegistry> {
  activeConfig = cfg
  const next = new JsonRegistry()
  await next.ingestFiles(files, cfg, { skipValidation: true })
  registry = next
  return next
}

/** Incrementally upsert a single file's entities into the shared registry. */
export function indexFile(path: string, name: string, content: any): void {
  if (!registry) return
  registry.indexFile(path, name, content, activeConfig)
}

/** Remove a single file's entities from the shared registry. */
export function removeFile(path: string): void {
  registry?.invalidateFile(path)
}

/** The GTS config the registry was built with. */
export function getActiveConfig(): GtsConfig {
  return activeConfig
}
