import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DB {
  sql: Database.Database
}

export function openSqlite(filename: string, defaultWorkspace: string = 'default') {
  // Ensure the directory exists before opening the database
  const dir = dirname(filename)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Directory might already exist, ignore
  }

  const sql = new Database(filename)
  sql.pragma('journal_mode = WAL')

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
