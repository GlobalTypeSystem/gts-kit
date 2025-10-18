import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

class DatabaseWrapper {
  private db: SqlJsDatabase
  private filename: string
  private statements: Map<string, any> = new Map()

  constructor(db: SqlJsDatabase, filename: string) {
    this.db = db
    this.filename = filename
  }

  exec(sql: string): void {
    this.db.exec(sql)
    this.save()
  }

  prepare(sql: string) {
    // Return a statement-like object
    return {
      run: (...params: any[]) => {
        this.db.run(sql, params)
        this.save()
        return { changes: this.db.getRowsModified() }
      },
      get: (...params: any[]) => {
        const stmt = this.db.prepare(sql)
        stmt.bind(params)
        if (stmt.step()) {
          const row = stmt.getAsObject()
          stmt.free()
          return row
        }
        stmt.free()
        return undefined
      },
      all: (...params: any[]) => {
        const stmt = this.db.prepare(sql)
        stmt.bind(params)
        const results: any[] = []
        while (stmt.step()) {
          results.push(stmt.getAsObject())
        }
        stmt.free()
        return results
      }
    }
  }

  private save(): void {
    const data = this.db.export()
    writeFileSync(this.filename, data)
  }

  close(): void {
    this.save()
    this.db.close()
  }
}

export interface DB {
  sql: DatabaseWrapper
}

let SQL: any = null

async function initSql() {
  if (!SQL) {
    SQL = await initSqlJs()
  }
  return SQL
}

export async function openSqlite(filename: string, defaultWorkspace: string = 'default'): Promise<DB> {
  // Ensure the directory exists before opening the database
  const dir = dirname(filename)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Directory might already exist, ignore
  }

  const SQL = await initSql()

  // Load existing database or create new one
  let db: SqlJsDatabase
  if (existsSync(filename)) {
    const buffer = readFileSync(filename)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  const sql = new DatabaseWrapper(db, filename)

  // Note: sql.js doesn't support WAL mode (it's in-memory with periodic saves)

  // Tables
  sql.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,           -- 'global' or 'workspace'
      workspace_id INTEGER,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_name ON workspaces(name);

    CREATE TABLE IF NOT EXISTS layouts (
      id TEXT PRIMARY KEY NOT NULL, -- the GTS entity ID
      workspace_id INTEGER NOT NULL, -- the workspace id
      target_filename TEXT, -- the file path
      target_schema_id TEXT, -- the schema ID
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_layout_anchor ON layouts(workspace_id, id);

    CREATE TABLE IF NOT EXISTS layout_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layout_id TEXT NOT NULL,
      version TEXT NOT NULL,
      author TEXT,
      label TEXT,
      tags TEXT,
      canvas TEXT NOT NULL,
      nodes TEXT NOT NULL,
      edges TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CONSTRAINT ux_layout_version UNIQUE(layout_id, version)
    );

  `)

  // Ensure default workspace exists
  const existing = sql.prepare('SELECT name FROM workspaces WHERE name = ?').get(defaultWorkspace)
  if (!existing) {
    sql.prepare('INSERT INTO workspaces (name) VALUES (?)').run(defaultWorkspace)
  }

  return { sql }
}
