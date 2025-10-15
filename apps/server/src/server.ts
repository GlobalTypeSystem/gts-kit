import express, { Express } from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { openSqlite } from './db.js'
import type { LayoutSaveRequest, LayoutSnapshot, GlobalSettings } from '@gts/shared'
import { JsonRegistry, getGtsConfig, GtsConfig, DEFAULT_GTS_CONFIG, parseJSONC, decodeGtsId, isGtsCandidateFileName } from '@gts/shared'
import { randomUUID } from 'crypto'
import type { Server } from 'node:http'
import type { ServerConfig } from './config.js'

// Re-export types for convenience
export type { LayoutSaveRequest, LayoutSnapshot, GlobalSettings } from '@gts/shared'

export interface ServerOptions {
  port?: number
  dbFile?: string
  allowAnonymous?: boolean
}

// In-memory registry for GTS entities
let registry: JsonRegistry = new JsonRegistry()

export interface ServerInstance {
  port: number
  stop: () => Promise<void>
  app: Express
}

/**
 * Recursively scan directory for JSON files
 */
async function scanDirectory(dir: string, files: Array<{ path: string; name: string; content: any }> = []): Promise<Array<{ path: string; name: string; content: any }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue
        }
        await scanDirectory(fullPath, files)
      } else if (entry.isFile() && isGtsCandidateFileName(entry.name)) {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const parsed = parseJSONC(content)
          files.push({
            path: fullPath,
            name: basename(fullPath),
            content: parsed
          })
        } catch (error) {
          // Skip invalid JSON files
        }
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return files
}

/**
 * Scan and load GTS entities into the registry
 */
export async function loadGtsEntities(scanFolder: string, cfg: GtsConfig, verbosity: 'silent' | 'normal' | 'debug' = 'normal'): Promise<JsonRegistry> {
  if (verbosity !== 'silent') {
    console.log(`[GTS Scanner] Scanning folder: ${scanFolder}`)
  }

  const startTime = Date.now()
  const files = await scanDirectory(scanFolder)

  // Use registry to process files
  registry.reset()
  registry.ingestFiles(files, cfg)

  const elapsed = Date.now() - startTime

  const objCount = registry.jsonObjs.size
  const schemaCount = registry.jsonSchemas.size
  const totalEntities = objCount + schemaCount

  if (verbosity !== 'silent') {
    console.log(`[GTS Scanner] Found ${files.length} JSON files, ${totalEntities} GTS entities (${objCount} objects, ${schemaCount} schemas) in ${elapsed}ms`)
  }

  if (verbosity === 'debug') {
    console.log('[GTS Scanner] GTS Entities:')
    for (const obj of registry.jsonObjs.values()) {
      console.log(`  - ${obj.id} (object) from ${obj.file?.name}`)
    }
    for (const schema of registry.jsonSchemas.values()) {
      console.log(`  - ${schema.id} (schema) from ${schema.file?.name}`)
    }
  }

  return registry
}

export function createApp(dbFile: string, defaultWorkspace: string = 'default'): Express {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))

  // Helper: format timezone offset like +0000
  function formatTzOffset(d: Date): string {
    const offsetMinutes = -d.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMinutes)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    return `${sign}${hh}${mm}`
  }

  // NGINX-like access log
  app.use((req, res, next) => {
    const start = process.hrtime.bigint()
    let bytesSent = 0

    const origWrite = res.write.bind(res)
    const origEnd = res.end.bind(res)

    // Intercept write/end to count bytes
    ;(res.write as any) = (chunk: any, encoding?: any, cb?: any) => {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) bytesSent += chunk.length
        else bytesSent += Buffer.byteLength(String(chunk), encoding || 'utf8')
      }
      return origWrite(chunk, encoding, cb)
    }
    ;(res.end as any) = (chunk?: any, encoding?: any, cb?: any) => {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) bytesSent += chunk.length
        else bytesSent += Buffer.byteLength(String(chunk), encoding || 'utf8')
      }
      return origEnd(chunk, encoding, cb)
    }

    res.on('finish', () => {
      // Prefer content-length if set explicitly
      const contentLength = res.getHeader('content-length')
      const sent = typeof contentLength === 'string' ? parseInt(contentLength, 10) || bytesSent : bytesSent
      const diffMs = Number(process.hrtime.bigint() - start) / 1_000_000

      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '-'
      const now = new Date()
      const timeLocal = `${String(now.getDate()).padStart(2, '0')}/${now.toLocaleString('en-US', { month: 'short' })}/${now.getFullYear()}:${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} ${formatTzOffset(now)}`

      const method = req.method
      const url = req.originalUrl || req.url
      const status = res.statusCode
      const proto = `HTTP/${req.httpVersion}`

      // Example: 127.0.0.1 - - [10/Oct/2000:13:55:36 +0000] "GET /path HTTP/1.1" 200 123 "-" "UA" 12.345
      console.log(`${ip} - - [${timeLocal}] "${method} ${url} ${proto}" ${status} ${sent} ${diffMs.toFixed(3)}`)
    })

    next()
  })

  // __dirname polyfill for ESM
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  // Open database
  const { sql } = openSqlite(dbFile, defaultWorkspace)

  // Helpers
  function nowIso() { return new Date().toISOString() }

  function ensureWorkspace(workspaceName: string) {
    let row = sql.prepare(`SELECT * FROM workspaces WHERE name = ?`).get(workspaceName) as any
    if (row) return row['id']
    sql.prepare(`INSERT INTO workspaces (name, created_at, updated_at) VALUES (?, ?, ?)`)
       .run(workspaceName, nowIso(), nowIso())
    row = sql.prepare(`SELECT * FROM workspaces WHERE name = ?`).get(workspaceName) as any
    return row['id'] || 1
  }

  function findLayout(workspaceId: string, entityId: string) {
    const row = sql.prepare(`SELECT * FROM layouts WHERE workspace_id = ? AND id = ?`).get(workspaceId, entityId) as any
    return row || null
  }

  function ensureLayout(workspaceName: string, entityId: string, filename: string, schemaId: string) {
    const workspaceId = ensureWorkspace(workspaceName)
    let row = findLayout(workspaceId, entityId)
    if (row) return row

    sql.prepare(`INSERT INTO layouts (id, workspace_id, target_filename, target_schema_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
       .run(entityId, workspaceId, filename, schemaId, nowIso(), nowIso())
    row = findLayout(workspaceId, entityId)
    return row
  }

  function getLatestVersion(layoutId: string) {
    const row = sql.prepare(`SELECT version FROM layout_versions WHERE layout_id = ? ORDER BY CAST(version AS INTEGER) DESC LIMIT 1`).get(layoutId) as any
    return row?.version ?? null
  }

  function toSnapshot(layoutId: string, version: string, row: any): LayoutSnapshot {
    const ws = sql.prepare(`SELECT name FROM workspaces WHERE id = ?`).get(row.workspace_id) as any
    const workspaceName = ws?.['name'] || defaultWorkspace
    return {
      layoutId,
      version,
      createdAt: row.created_at,
      target: { workspaceName: workspaceName, id: row.id, filename: row.target_filename, schemaId: row.target_schema_id },
      canvas: JSON.parse(row.canvas),
      nodes: JSON.parse(row.nodes),
      edges: JSON.parse(row.edges),
      meta: row.meta ? JSON.parse(row.meta) : undefined,
    }
  }

  // Health
  app.get('/health', (_req, res) => {
    const totalEntities = registry.jsonObjs.size + registry.jsonSchemas.size
    res.json({ status: 'ok', db: 'ok', backendVersion: '0.1.0', gtsEntities: totalEntities })
  })

  // Get GTS entity by ID
  app.get('/gts/:name', (req, res) => {
    const { name } = req.params

    // Ensure name starts with 'gts.'
    const entityId = name.startsWith('gts.') ? name : `gts.${name}`

    // Try to find in objects first, then schemas
    const obj = registry.jsonObjs.get(entityId)
    const schema = registry.jsonSchemas.get(entityId)
    const entity = obj || schema

    if (!entity) {
      return res.status(404).json({ error: 'not_found', message: `GTS entity '${entityId}' not found` })
    }

    res.json({
      id: entity.id,
      content: entity.content,
      file: {
        path: entity.file?.path,
        name: entity.file?.name
      },
      isSchema: entity.isSchema
    })
  })

  // Settings (global only for now)
  app.get('/settings', (_req, res) => {
    const row = sql.prepare(`SELECT data FROM settings WHERE scope = 'global' LIMIT 1`).get() as any
    if (!row) {
      const defaults: GlobalSettings = {
        db: { dialect: 'sqlite', sqlite: { filename: dbFile } },
        features: { enableVersioning: true, enableImportExport: true, allowAnonymous: true }
      }
      return res.json(defaults)
    }
    res.json(JSON.parse(row.data))
  })

  app.put('/settings', (req, res) => {
    const payload: GlobalSettings = req.body
    const existing = sql.prepare(`SELECT id FROM settings WHERE scope = 'global' LIMIT 1`).get() as any
    if (existing) {
      sql.prepare(`UPDATE settings SET data = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(payload), nowIso(), existing.id)
    } else {
      sql.prepare(`INSERT INTO settings (id, scope, data, created_at, updated_at) VALUES (?, 'global', ?, ?, ?)`)
        .run(randomUUID(), JSON.stringify(payload), nowIso(), nowIso())
    }
    res.json(payload)
  })

  // Static assets
  app.use(express.static(path.join(__dirname)))
  app.use('/public', express.static(path.join(__dirname, 'public')))

  // Docs and OpenAPI routes
  app.get('/docs', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public/docs.html'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  })

  app.get('/openapi.yaml', (_req, res) => {
    res.sendFile(path.join(__dirname, 'openapi.yaml'), {
      headers: { 'Content-Type': 'application/yaml; charset=utf-8' },
    })
  })

  // Root route -> redirect to /layouts for backward compatibility
  app.get('/', (req, res) => {
    res.redirect(307, '/layouts' + (req.url.substring(1) ? '?' + req.url.substring(2) : ''))
  })

  // Get latest layout or a specific version (simplified API: workspace + id only)
  app.get('/layouts', (req, res) => {
    const workspaceName = (req.query.workspace as string) || defaultWorkspace
    const workspaceId = ensureWorkspace(workspaceName)
    const id = decodeGtsId((req.query.id as string) || '')
    const version = (req.query.version as string) || null

    if (!id) {
      return res.status(400).json({ error: 'bad_request', message: 'id parameter is required' })
    }

    const layout = findLayout(workspaceId, id)
    if (!layout) return res.status(404).json({ error: 'not_found' })

    let row: any
    if (version) {
      row = sql.prepare(`SELECT v.*, l.workspace_id, l.id, l.target_filename, l.target_schema_id FROM layout_versions v JOIN layouts l ON l.id = v.layout_id WHERE v.layout_id = ? AND v.version = ?`).get(layout.id, version)
    } else {
      row = sql.prepare(`SELECT v.*, l.workspace_id, l.id, l.target_filename, l.target_schema_id FROM layout_versions v JOIN layouts l ON l.id = v.layout_id WHERE v.layout_id = ? ORDER BY CAST(v.version AS INTEGER) DESC LIMIT 1`).get(layout.id)
    }
    if (!row) return res.status(404).json({ error: 'not_found' })
    return res.json(toSnapshot(layout.id, row.version, row))
  })

  // Save new layout version
  app.post('/layouts', (req, res) => {
    const payload = req.body as LayoutSaveRequest
    const { target } = payload
    const workspaceName = target.workspaceName || defaultWorkspace
    const entityId = decodeGtsId(target.id)
    const anchor = ensureLayout(workspaceName, entityId, target.filename, target.schemaId)

    const latest = getLatestVersion(anchor.id)
    const next = String((latest ? parseInt(latest, 10) : 0) + 1)

    sql.prepare(`INSERT INTO layout_versions (layout_id, version, canvas, nodes, edges, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        anchor.id,
        next,
        JSON.stringify(payload.canvas),
        JSON.stringify(payload.nodes),
        JSON.stringify(payload.edges),
        payload.meta ? JSON.stringify(payload.meta) : null,
        nowIso()
      )

    const row = sql.prepare(`SELECT v.*, l.workspace_id, l.id, l.target_filename, l.target_schema_id FROM layout_versions v JOIN layouts l ON l.id = v.layout_id WHERE v.layout_id = ? AND v.version = ?`).get(anchor.id, next)
    res.status(201).json(toSnapshot(anchor.id, next, row))
  })

  // List versions for a target
  app.get('/layouts/versions', (req, res) => {
    const workspaceName = (req.query.workspace as string) || defaultWorkspace
    const workspaceId = ensureWorkspace(workspaceName)
    const id = decodeGtsId((req.query.id as string) || '')
    const page = parseInt((req.query.page as string) || '1', 10)
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200)
    const offset = (page - 1) * limit

    if (!id) {
      return res.status(400).json({ error: 'bad_request', message: 'id parameter is required' })
    }

    const layout = findLayout(workspaceId, id)
    if (!layout) return res.json({ items: [], page, limit, total: 0 })

    const items = sql.prepare(`SELECT version, created_at, author, label, tags FROM layout_versions WHERE layout_id = ? ORDER BY CAST(version AS INTEGER) DESC LIMIT ? OFFSET ?`).all(layout.id, limit, offset)
    const totalRow = sql.prepare(`SELECT COUNT(*) as c FROM layout_versions WHERE layout_id = ?`).get(layout.id) as any

    res.json({ items: items.map((r: any) => ({
      layoutId: layout.id,
      version: r.version,
      createdAt: r.created_at,
      author: r.author ?? null,
      label: r.label ?? null,
      tags: r.tags ? JSON.parse(r.tags) : []
    })), page, limit, total: totalRow.c })
  })

  // Get a specific version by layoutId + version
  app.get('/layouts/:layoutId/versions/:version', (req, res) => {
    const { layoutId, version } = req.params
    const row = sql.prepare(`SELECT v.*, l.workspace_id, l.id, l.target_filename, l.target_schema_id FROM layout_versions v JOIN layouts l ON l.id = v.layout_id WHERE v.layout_id = ? AND v.version = ?`).get(layoutId, version)
    if (!row) return res.status(404).json({ error: 'not_found' })
    res.json(toSnapshot(layoutId, version, row))
  })

  // Restore a specific version as latest (clone)
  app.post('/layouts/:layoutId/versions/:version', (req, res) => {
    const { layoutId, version } = req.params
    const row = sql.prepare(`SELECT * FROM layout_versions WHERE layout_id = ? AND version = ?`).get(layoutId, version) as any
    if (!row) return res.status(404).json({ error: 'not_found' })
    const latest = getLatestVersion(layoutId)
    const next = String((latest ? parseInt(latest, 10) : 0) + 1)
    sql.prepare(`INSERT INTO layout_versions (layout_id, version, canvas, nodes, edges, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(layoutId, next, row.canvas, row.nodes, row.edges, row.meta, nowIso())
    const joined = sql.prepare(`SELECT v.*, l.workspace_id, l.id, l.target_filename, l.target_schema_id FROM layout_versions v JOIN layouts l ON l.id = v.layout_id WHERE v.layout_id = ? AND v.version = ?`).get(layoutId, next)
    res.status(201).json(toSnapshot(layoutId, next, joined))
  })

  return app
}

export async function startServer(config: ServerConfig | ServerOptions = {}): Promise<ServerInstance> {
  // Support both old ServerOptions and new ServerConfig
  const isServerConfig = 'scanFolder' in config
  const port = isServerConfig ? config.port : (config.port || parseInt(process.env.GTS_SERVER_PORT || '7080', 10))
  const dbFile = isServerConfig ? config.dbFile! : (config.dbFile || process.env.GTS_SERVER_DB_FILE || 'viewer.db')
  const verbosity = isServerConfig ? config.verbosity : 'normal'
  const scanFolder = isServerConfig ? config.scanFolder : process.cwd()
  const gtsConfig = isServerConfig ? getGtsConfig(config.gts) : DEFAULT_GTS_CONFIG
  const defaultWorkspace = isServerConfig ? config.defaultWorkspace : 'default'

  // Scan and load GTS entities
  if (isServerConfig) {
    await loadGtsEntities(scanFolder, gtsConfig, verbosity)
  }

  const app = createApp(dbFile, defaultWorkspace)

  return new Promise((resolve, reject) => {
    let server: Server | null = null

    try {
      server = app.listen(port, () => {
        console.log(`[GTS API] listening on http://localhost:${port}`)
        console.log(`[GTS API] database: ${dbFile}`)

        resolve({
          port,
          app,
          stop: async () => {
            return new Promise((resolveStop, rejectStop) => {
              if (server) {
                server.close((err) => {
                  if (err) rejectStop(err)
                  else {
                    console.log('[GTS API] server stopped')
                    resolveStop()
                  }
                })
              } else {
                resolveStop()
              }
            })
          }
        })
      })

      server.on('error', reject)
    } catch (err) {
      reject(err)
    }
  })
}
