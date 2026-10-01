import * as vscode from 'vscode'
import * as path from 'path'
import ignore, { type Ignore } from 'ignore'

/**
 * Loads every .gitignore in the workspace and exposes, per workspace folder:
 *  - `matcher`: an authoritative gitignore matcher (correct semantics, including
 *    negations and nesting) for single-path checks.
 *  - `excludeGlobs`: VS Code exclude globs derived from the same rules, used to
 *    keep `findFiles` from even enumerating ignored (often huge) directories.
 *
 * Nested .gitignore files are rebased so their patterns are relative to their
 * workspace folder's root, letting one matcher/one glob set cover the folder.
 * Folders are kept apart: in a multi-root workspace one folder's rules must not
 * hide same-named paths in another folder.
 */

export interface FolderIgnore {
  /** fsPath of the workspace folder these rules are relative to. */
  root: string
  matcher: Ignore
  excludeGlobs: string[]
}

let cached: Map<string, FolderIgnore> | null = null

interface RebasedPattern { pattern: string; negated: boolean }

/** Rebase a single .gitignore line (from a gitignore located at `dirRel`) to a
 *  workspace-root-relative gitignore pattern. Returns null for blanks/comments. */
function rebasePattern(line: string, dirRel: string): RebasedPattern | null {
  let s = line.replace(/\r$/, '').trim()
  if (!s || s.startsWith('#')) return null

  let negated = false
  if (s.startsWith('!')) { negated = true; s = s.slice(1) }
  // Unescape a leading "\#" / "\!".
  s = s.replace(/^\\([#!])/, '$1')
  if (!s) return null

  const rootDir = dirRel && dirRel !== '.' ? dirRel.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  const anchored = s.startsWith('/')
  if (anchored) s = s.slice(1)
  const trailingSlash = s.endsWith('/')
  const core = s.replace(/\/+$/, '')
  if (!core) return null

  const hasMiddleSlash = core.includes('/')
  let rebased: string
  if (!rootDir) {
    rebased = (anchored || hasMiddleSlash) ? `/${core}` : core
  } else if (anchored || hasMiddleSlash) {
    rebased = `/${rootDir}/${core}`
  } else {
    // A no-slash pattern matches at any depth *below* the gitignore's directory.
    rebased = `/${rootDir}/**/${core}`
  }
  if (trailingSlash) rebased += '/'
  return { pattern: (negated ? '!' : '') + rebased, negated }
}

/** Convert a rebased (root-relative) gitignore pattern into VS Code exclude globs. */
function patternToGlobs(rootRelPattern: string): string[] {
  const anchoredOrNested = rootRelPattern.startsWith('/') || rootRelPattern.replace(/\/+$/, '').includes('/')
  const p = rootRelPattern.replace(/^\//, '').replace(/\/+$/, '')
  if (!p) return []
  return anchoredOrNested
    ? [p, `${p}/**`]
    : [`**/${p}`, `**/${p}/**`]
}

/** Load (and cache) the gitignore rules of every workspace folder, keyed by folder fsPath. */
export async function getWorkspaceIgnore(): Promise<Map<string, FolderIgnore>> {
  if (cached) return cached
  const byFolder = new Map<string, { matcher: Ignore; globs: Set<string> }>()
  for (const folder of vscode.workspace.workspaceFolders || []) {
    byFolder.set(folder.uri.fsPath, { matcher: ignore(), globs: new Set() })
  }
  try {
    // No result cap: a missed .gitignore silently un-ignores whole trees.
    const uris = await vscode.workspace.findFiles('**/.gitignore', '**/{.git,node_modules}/**')
    for (const uri of uris) {
      const folder = vscode.workspace.getWorkspaceFolder(uri)
      const entry = folder && byFolder.get(folder.uri.fsPath)
      if (!folder || !entry) continue
      let text: string
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
      } catch { continue }
      const dirRel = path.relative(folder.uri.fsPath, path.dirname(uri.fsPath))
      for (const line of text.split('\n')) {
        const r = rebasePattern(line, dirRel)
        if (!r) continue
        entry.matcher.add(r.pattern)
        // Negations can't be expressed as an exclude glob; the matcher remains
        // authoritative for those. Only non-negated rules feed the glob set.
        if (!r.negated) for (const g of patternToGlobs(r.pattern)) entry.globs.add(g)
      }
    }
  } catch (e) {
    console.error('[GTS] Failed to load .gitignore rules:', e)
  }
  const result = new Map<string, FolderIgnore>()
  for (const [root, { matcher, globs }] of byFolder) result.set(root, { root, matcher, excludeGlobs: [...globs] })
  cached = result
  return result
}

/** Drop the cache so the next call re-reads .gitignore files. */
export function resetWorkspaceIgnore(): void {
  cached = null
}

/**
 * True if the file (or, with `isDirectory`, the folder) is gitignored by the
 * rules of the workspace folder that contains it. Uses the given rules, or the
 * cached ones (sync, for hot paths); false before the rules have been loaded
 * and for paths outside every workspace folder.
 */
export function isGitIgnored(uri: vscode.Uri, isDirectory = false, ignores = cached): boolean {
  if (!ignores) return false
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  const entry = folder && ignores.get(folder.uri.fsPath)
  if (!folder || !entry) return false
  const rel = path.relative(folder.uri.fsPath, uri.fsPath)
  return isIgnoredRel(entry.matcher, isDirectory && rel ? rel + '/' : rel)
}

/** True if a folder-relative path is gitignored per the given matcher. */
export function isIgnoredRel(matcher: Ignore | null, relPath: string): boolean {
  if (!matcher || !relPath || relPath.startsWith('..')) return false
  const posix = relPath.replace(/\\/g, '/')
  if (!posix || posix.startsWith('/')) return false
  try {
    return matcher.ignores(posix)
  } catch {
    return false
  }
}
