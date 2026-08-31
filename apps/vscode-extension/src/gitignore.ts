import * as vscode from 'vscode'
import * as path from 'path'
import ignore, { type Ignore } from 'ignore'

/**
 * Loads every .gitignore in the workspace and exposes:
 *  - `matcher`: an authoritative gitignore matcher (correct semantics, including
 *    negations and nesting) for single-path checks.
 *  - `excludeGlobs`: VS Code exclude globs derived from the same rules, used to
 *    keep `findFiles` from even enumerating ignored (often huge) directories.
 *
 * Nested .gitignore files are rebased so their patterns are workspace-root
 * relative, letting one matcher/one glob set cover the whole workspace.
 */

let cached: { matcher: Ignore; excludeGlobs: string[] } | null = null

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

/** Load (and cache) the workspace gitignore matcher + derived exclude globs. */
export async function getWorkspaceIgnore(): Promise<{ matcher: Ignore; excludeGlobs: string[] }> {
  if (cached) return cached
  const matcher = ignore()
  const globs = new Set<string>()
  try {
    const uris = await vscode.workspace.findFiles('**/.gitignore', '**/{.git,node_modules}/**', 500)
    for (const uri of uris) {
      let text: string
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
      } catch { continue }
      const dirRel = path.dirname(vscode.workspace.asRelativePath(uri, false))
      for (const line of text.split('\n')) {
        const r = rebasePattern(line, dirRel)
        if (!r) continue
        matcher.add(r.pattern)
        // Negations can't be expressed as an exclude glob; the matcher remains
        // authoritative for those. Only non-negated rules feed the glob set.
        if (!r.negated) for (const g of patternToGlobs(r.pattern)) globs.add(g)
      }
    }
  } catch (e) {
    console.error('[GTS] Failed to load .gitignore rules:', e)
  }
  cached = { matcher, excludeGlobs: [...globs] }
  return cached
}

/** Drop the cache so the next call re-reads .gitignore files. */
export function resetWorkspaceIgnore(): void {
  cached = null
}

/** The cached matcher, or null if not loaded yet (sync accessor for hot paths). */
export function getCachedMatcher(): Ignore | null {
  return cached?.matcher ?? null
}

/** True if a workspace-relative path is gitignored per the given matcher. */
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
