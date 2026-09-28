import * as esbuild from 'esbuild'
import { promises as fs } from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/**
 * gts-ts compiles schema patterns with re2-wasm, which loads its `re2.wasm`
 * binary from the directory of the running script. Bundled, that is `dist/`,
 * so the binary must sit next to `dist/extension.js` or the extension throws
 * on load. Resolved through gts-ts so it's the exact copy gts-ts depends on.
 *
 * @type {esbuild.Plugin}
 */
const copyRe2WasmPlugin = {
  name: 'copy-re2-wasm',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length > 0) return
      const gtsTsDir = path.dirname(require.resolve('@globaltypesystem/gts-ts/package.json', { paths: ['../../packages/shared'] }))
      const re2Dir = path.dirname(require.resolve('re2-wasm/package.json', { paths: [gtsTsDir] }))
      await fs.copyFile(path.join(re2Dir, 'build', 'wasm', 're2.wasm'), path.join('dist', 're2.wasm'))
    })
  },
}

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/**
 * @type {esbuild.Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started')
    })
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(`    ${location.file}:${location.line}:${location.column}:`)
      })
      console.log('[watch] build finished')
    })
  },
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    // Mark these as external to avoid bundling issues with dynamic requires
    // They'll be loaded from node_modules at runtime
    mainFields: ['module', 'main'],
    plugins: [
      esbuildProblemMatcherPlugin,
      copyRe2WasmPlugin,
    ],
  })

  if (watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
