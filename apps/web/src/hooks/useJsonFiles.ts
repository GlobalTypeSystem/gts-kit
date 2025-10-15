import React, { useState, useRef } from 'react'
import { JsonRegistry, parseJSONC } from '@gts/shared'
import { Scanner } from '../../../../packages/fs-adapters/types'
// Use the smart scanner that automatically chooses the best implementation
import { WebSmartScanner } from '../../../../packages/fs-adapters/fs-adapter-web/src/index'
import { AppConfig } from '@/lib/config'
import { ViewerModel } from './viewerModel'

// Generic hook that works with any scanner implementation
export function useJsonObjsWithScanner(createScanner: () => Scanner) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasAccess, setHasAccess] = useState(false)
  const [initialSelectedId, setInitialSelectedId] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const scannerRef = useRef<Scanner | null>(null)
  const registryRef = useRef<JsonRegistry>(new JsonRegistry())
  const watcherRef = useRef<(() => void) | null>(null)
  const hasInitiallySelectedRef = useRef<boolean>(false)

  // Browser/Electron init path:
  // - Prompt for directory, scan and ingest files
  // - Registry determines default file; we compute `initialSelectedId` once
  async function chooseDirectory() {
    try {
      setError(null)
      setLoading(true)

      // Stop any existing watcher
      if (watcherRef.current) {
        watcherRef.current()
        watcherRef.current = null
      }

      const scanner = createScanner()
      await scanner.requestDirectoryAccess() // user gesture required from caller
      scannerRef.current = scanner
      setHasAccess(true)
      await loadFromScanner()

      // Start watching for file changes
      startWatching()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open directory')
      setHasAccess(false)
      registryRef.current.reset()
      setVersion(v => v + 1)
    } finally {
      setLoading(false)
    }
  }

  // Core loader for browser/electron:
  // - List matching files via Scanner and parse JSON/JSONC
  // - Ingest into JsonRegistry and bump version
  // - Call registry.setDefaultFile(...) to drive initial selection
  // - Compute `initialSelectedId` from default file on first run only
  async function loadFromScanner() {
    const scanner = scannerRef.current
    if (!scanner) return

    const docs = await scanner.list({ glob: '**/*.{json,jsonc,gts}' })
    const files: Array<{ path: string; name: string; content: any }> = []

    for (const d of docs) {
      try {
        const text = await scanner.read(d.path)
        try {
          const content = parseJSONC(text)
          files.push({ path: d.path, name: d.name, content })
        } catch (e) {
          if (text.includes('gts.')) {
            // Still push malformed JSONC to show proper error messages
            files.push({ path: d.path, name: d.name, content: text })
          }
        }
      } catch (e) {
        // Skip unreadable/invalid JSONC
      }
    }

    const registry = registryRef.current
    registry.reset()
    await registry.ingestFiles(files, AppConfig.get().gts)
    setVersion(v => v + 1)

    // Determine default file path (first file with entities)
    registry.setDefaultFile(null)
    const defaultPath = registry.getDefaultFilePath()

    // Only set initial selection once per app session
    if (!hasInitiallySelectedRef.current && defaultPath) {
      hasInitiallySelectedRef.current = true
      // Filter objects and schemas from the default file
      const objsFromFile = Array.from(registry.jsonObjs.values()).filter(o => o.file?.path === defaultPath)
      const firstObj = objsFromFile.find(o => o.listSequence === undefined || o.listSequence === 0) || objsFromFile[0]
      if (firstObj) setInitialSelectedId(firstObj.id)
      else {
        const schemasFromFile = Array.from(registry.jsonSchemas.values()).filter(s => s.file?.path === defaultPath)
        const firstSchema = schemasFromFile.find(s => s.listSequence === undefined || s.listSequence === 0) || schemasFromFile[0]
        if (firstSchema) setInitialSelectedId(firstSchema.id)
      }
    }
  }

  // Refresh path (browser/electron):
  // - Re-run loadFromScanner; SharedApp coordinates preserving selection/viewport
  async function reload() {
    try {
      setLoading(true)
      setError(null)
      await loadFromScanner()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reload files')
    } finally {
      setLoading(false)
    }
  }

  // Watch for file changes and trigger reloads to keep registry/layout in sync
  function startWatching() {
    const scanner = scannerRef.current
    if (!scanner) return

    // Stop any existing watcher
    if (watcherRef.current) {
      watcherRef.current()
    }

    // Start new watcher
    watcherRef.current = scanner.watch(
      { glob: '**/*.{json,jsonc,gts}' },
      (change) => {
        console.log('File change detected:', change)
        // Reload data when files change
        loadFromScanner().catch(err => {
          console.error('Failed to reload after file change:', err)
        })
      }
    )
  }

  // Cleanup watcher on unmount
  React.useEffect(() => {
    return () => {
      if (watcherRef.current) {
        watcherRef.current()
      }
    }
  }, [])

  return new ViewerModel({
    registry: registryRef.current,
    version,
    loading,
    error,
    reload,
    chooseDirectory,
    needsDirectory: !hasAccess,
    initialSelectedId,
  })
}

// Web-specific hook that uses WebSmartScanner (auto-detects browser support)
export function useJsonObjs() {
  return useJsonObjsWithScanner(() => new WebSmartScanner())
}
