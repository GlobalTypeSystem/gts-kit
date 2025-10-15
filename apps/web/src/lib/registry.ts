import { JsonFile, JsonObj, JsonSchema } from '@/lib/entities'

// Global registries (cleared and repopulated on each parsing)
export const JsonObjHash: Map<string, JsonObj> = new Map()
export const JsonSchemaHash: Map<string, JsonSchema> = new Map()
export const JsonFilesHash: Map<string, JsonFile> = new Map()

// Centralized fetch cache must live only here
const fetchCache: Map<string, Promise<any>> = new Map()

export function resetRegistry(): void {
  JsonObjHash.clear()
  JsonSchemaHash.clear()
  JsonFilesHash.clear()
  fetchCache.clear()
}

export function populateRegistry(
  objs: JsonObj[],
  schemas: JsonSchema[],
  files: JsonFile[]
): void {
  resetRegistry()
  for (const f of files) JsonFilesHash.set(f.path, f)
  for (const o of objs) JsonObjHash.set(o.id, o)
  for (const s of schemas) JsonSchemaHash.set(s.id, s)
}

export function getRegistrySnapshot(): {
  objs: Record<string, JsonObj>
  schemas: Record<string, JsonSchema>
  files: Record<string, JsonFile>
} {
  return {
    objs: Object.fromEntries(JsonObjHash.entries()),
    schemas: Object.fromEntries(JsonSchemaHash.entries()),
    files: Object.fromEntries(JsonFilesHash.entries()),
  }
}

/**
 * Fetch JSON with centralized caching. Path can be repo-relative or absolute; we normalize to leading '/'.
 */
export async function fetchJson(path: string, force = false): Promise<any> {
  const key = path.startsWith('/') ? path : `/${path}`
  if (!force && fetchCache.has(key)) return fetchCache.get(key)!
  const p = (async () => {
    const res = await fetch(key)
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`)
    return res.json()
  })()
  fetchCache.set(key, p)
  return p
}

/**
 * Read a JSON file and upsert its JsonFile record in the registry.
 */
export async function upsertFileFromPath(path: string, force = false): Promise<JsonFile> {
  const content = await fetchJson(path, force)
  const name = path.split('/').pop() || path
  const file: JsonFile = new JsonFile(path, name, content)
  JsonFilesHash.set(path, file)
  return file
}
