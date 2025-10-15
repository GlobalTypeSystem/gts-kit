import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'dir-listing-endpoint',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          try {
            if (!req.url || !req.url.startsWith('/__list')) return next()
            const url = new URL(req.url, 'http://localhost')
            const dirParam = url.searchParams.get('dir') || ''
            const recursive = url.searchParams.get('recursive') === '1'
            const ext = url.searchParams.get('ext') || ''

            const viewerRoot = process.cwd()
            const repoRoot = path.resolve(viewerRoot, '..')
            const absTarget = path.resolve(repoRoot, dirParam)

            // Security: only allow listing under examples/events
            const allowedRoots = [
              path.resolve(repoRoot, 'examples'),
              path.resolve(repoRoot, 'examples/events'),
            ]
            if (!allowedRoots.some((root) => absTarget.startsWith(root))) {
              res.statusCode = 403
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Forbidden' }))
              return
            }

            const walk = async (dirAbs: string, dirRel: string, collected: string[]): Promise<void> => {
              const entries = await fs.promises.readdir(dirAbs, { withFileTypes: true })
              for (const ent of entries) {
                const nextAbs = path.resolve(dirAbs, ent.name)
                const nextRel = path.posix.join(dirRel.replace(/\\/g, '/'), ent.name)
                if (ent.isDirectory()) {
                  if (recursive) {
                    await walk(nextAbs, nextRel, collected)
                  }
                } else if (ent.isFile()) {
                  if (!ext || nextRel.endsWith(ext)) {
                    collected.push(nextRel)
                  }
                }
              }
            }

            const files: string[] = []
            await walk(absTarget, dirParam, files)

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(files))
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: (e as any)?.message || 'internal error' }))
          }
        })
      },
    },
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['..', '../..']
    }
  }
})
