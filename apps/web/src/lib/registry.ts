import { JsonFile, JsonObj, JsonSchema } from '@/lib/entities'

// Global registries (cleared and repopulated on each parsing)
export const JsonObjHash: Map<string, JsonObj> = new Map()
export const JsonSchemaHash: Map<string, JsonSchema> = new Map()
export const JsonFilesHash: Map<string, JsonFile> = new Map()

export function resetRegistry(): void {
  JsonObjHash.clear()
  JsonSchemaHash.clear()
  JsonFilesHash.clear()
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

/**
 * Fetch JSON with centralized caching. Path can be repo-relative or absolute; we normalize to leading '/'.
 */
export async function fetchJson(path: string): Promise<any> {
  const p = (async () => {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`)
    return res.json()
  })()
  return p
}
