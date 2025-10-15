import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { JsonFile, JsonObj, JsonSchema, ValidationResult } from '@/lib/entities'
import { AppConfig } from '@/lib/config'
import { populateRegistry, fetchJson } from '../lib/registry'

// Initialize Ajv with format validation (loose to allow custom x-* keywords)
const ajv = new Ajv({ allErrors: true, verbose: true, strict: false })
addFormats(ajv)

// Delegate JSON loading to centralized registry cache
export async function loadJsonFile(path: string, force = false): Promise<any> {
  return fetchJson(path, force)
}

/**
 * Check if a file path matches any of the given patterns
 */

// (path resolution not needed anymore for linking by IDs only)

/**
 * Discover all JSON files in the examples directory
 */
async function discoverFiles(baseDir: string, filter: (p: string) => boolean, extHint?: string): Promise<string[]> {
  // Prefer custom dev endpoint when available
  try {
    const u = `/__list?dir=${encodeURIComponent(baseDir)}&recursive=1${extHint ? `&ext=${encodeURIComponent(extHint)}` : ''}`
    const res = await fetch(u)
    if (res.ok) {
      const files: string[] = await res.json()
      return files.filter(filter)
    }
  } catch {}

  // Try index.json manifest if present
  try {
    const indexPath = baseDir.endsWith('/') ? `${baseDir}index.json` : `${baseDir}/index.json`
    const res = await fetch(indexPath.startsWith('/') ? indexPath : `/${indexPath}`)
    if (res.ok) {
      const list: string[] = await res.json()
      return list.map(p => (p.startsWith('/') ? p.slice(1) : `${baseDir}${p}`)).filter(filter)
    }
  } catch {}

  // Fallback: parse simple directory listing
  try {
    const requestPath = baseDir.startsWith('/') ? baseDir : `/${baseDir}`
    const res = await fetch(requestPath)
    if (!res.ok) return []
    const html = await res.text()
    const hrefs: string[] = []
    const hrefRegex = /href=\"([^\"]+)\"/g
    let m: RegExpExecArray | null
    while ((m = hrefRegex.exec(html)) !== null) hrefs.push(m[1])
    const normalize = (href: string): string | null => {
      if (!href) return null
      const [clean] = href.split(/[?#]/, 1)
      if (!clean || clean.endsWith('/') || clean.startsWith('..')) return null
      let p = clean
      if (p.startsWith('/')) p = p.slice(1)
      else if (p.startsWith('./')) p = `${baseDir}${p.slice(2)}`
      else p = `${baseDir}${p}`
      return p
    }
    return hrefs.map(normalize).filter((p): p is string => !!p).filter(filter)
  } catch {
    return []
  }
}

// Unified discovery: list all *.json files under the selected base directory
export async function discoverJsonFiles(baseDir: string): Promise<string[]> {
  return discoverFiles(baseDir, p => p.endsWith('.json'), '.json')
}

/**
 * Extract $ref references from a schema with their field paths
 */

/**
 * Extract $ref references from a schema (legacy function for compatibility)
 */

// GTS ID regex, calculators and extractors moved to utils/entities

/**
 * Determine if an entity is a JSON Schema based on $schema URL.
 * Schemas always have $schema referring standard json schema URL.
 */
export function isJsonSchemaEntity(entity: any): boolean {
  const url = typeof entity?.$schema === 'string' ? entity.$schema : ''
  return /^https?:\/\/json-schema\.org\//i.test(url)
}

// All calculators and extractors live in utils/entities; models compute defaults in constructors

/**
 * Validate a JSON file against its schema
 */
export function validateJson(data: any, schema: any, allSchemas?: Map<string, any>): ValidationResult {
  try {
    const ajvInstance = new Ajv({ allErrors: true, verbose: true, strict: false })
    addFormats(ajvInstance)
    if (allSchemas) {
      for (const [schemaPath, schemaContent] of allSchemas.entries()) {
        const baseName = schemaPath.split('/').pop() || schemaPath
        const candidates = new Set<string>([schemaPath, baseName])
        if (typeof schemaContent?.$id === 'string') candidates.add(schemaContent.$id)
        for (const key of candidates) {
          try {
            ajvInstance.addSchema(schemaContent, key)
          } catch (e: any) {
            if (!/already exists/i.test(String(e?.message || ''))) {
              console.warn(`Failed to add schema with key ${key}:`, e)
            }
          }
        }
      }
    }
    const validate = ajvInstance.compile(schema)
    const valid = validate(data)
    if (!valid && validate.errors) {
      const errors = validate.errors.map(error => `${error.instancePath || 'root'}: ${error.message}`)
      return { valid: false, errors }
    }
    return { valid: true, errors: [] }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Validation failed'
    return { valid: false, errors: [msg] }
  }
}

/**
 * Load all JSON files and schemas, parse single/list entities, classify and validate.
 */
export async function loadAllFiles(baseDir: string): Promise<{ jsonFiles: JsonObj[]; schemas: JsonSchema[] }> {
  try {
    await AppConfig.init()
    const cfg = AppConfig.get()
    if (!cfg) throw new Error('Failed to load GTS config')
    const allJsonPaths = await discoverJsonFiles(baseDir)
    const jsonSchemas: JsonSchema[] = []
    const jsonObjs: JsonObj[] = []
    const files: JsonFile[] = []

    for (const filePath of allJsonPaths) {
      try {
        const content = await loadJsonFile(filePath)
        const fileName = filePath.split('/').pop() || filePath
        const fileRef: JsonFile = new JsonFile(filePath, fileName, content)
        files.push(fileRef)

        const entities = Array.isArray(content) ? content : [content]
        entities.forEach((entity, idx) => {
          const seq = Array.isArray(content) ? idx : undefined
          if (isJsonSchemaEntity(entity)) {
            jsonSchemas.push(new JsonSchema({ file: fileRef, listSequence: seq, content: entity }))
          } else {
            jsonObjs.push(new JsonObj({ file: fileRef, listSequence: seq, content: entity }))
          }
        })
      } catch (e) {
        console.error(`Failed to load JSON file ${filePath}:`, e)
      }
    }

    // Populate registry for consumers; links are by IDs only
    try {
      populateRegistry(jsonObjs, jsonSchemas, files)
    } catch (e) {
      console.warn('Failed to populate registry:', e)
    }
    return { jsonFiles: jsonObjs, schemas: jsonSchemas }
  } catch (error) {
    console.error('Error loading files:', error)
    throw error
  }
}
