import React, { useState, useRef } from 'react'
import { JsonRegistry, parseJSONC, parseYAML } from '@gts/shared'
import { Scanner, FileChange } from '../../../../packages/fs-adapters/types'
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
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const scannerRef = useRef<Scanner | null>(null)
  const registryRef = useRef<JsonRegistry>(new JsonRegistry())
  const watcherRef = useRef<(() => void) | null>(null)
  const hasInitiallySelectedRef = useRef<boolean>(false)
  // Serializes incremental file-change handling so overlapping watch events
  // don't validate against a half-updated registry.
  const changeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const versionBumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Browser/Electron init path:
  // - Prompt for directory, scan and ingest files
  // - Registry determines default file; we compute `initialSelectedId` once
  async function chooseDirectory() {
    try {
      setError(null)
      setLoading(true)
      setProgress(null)

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

    // Signal that directory listing is in progress (total=0 means listing phase)
    setProgress({ processed: 0, total: 0 })
    // Yield to let React flush the loading state before heavy directory walk
    await new Promise(r => setTimeout(r, 0))

    const docs = await scanner.list({ glob: '**/*.{json,jsonc,gts,yaml,yml}' })
    const files: Array<{ path: string; name: string; content: any }> = []
    const total = docs.length
    setProgress({ processed: 0, total })

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]
      try {
        const text = await scanner.read(d.path)
        const isYaml = d.name.endsWith('.yaml') || d.name.endsWith('.yml')
        try {
          const content = isYaml ? parseYAML(text) : parseJSONC(text)
          files.push({ path: d.path, name: d.name, content })
        } catch (e) {
          if (text.includes('gts.')) {
            // Still push malformed files to show proper error messages
            files.push({ path: d.path, name: d.name, content: text })
          }
        }
      } catch (e) {
        // Skip unreadable/invalid files
      }
      // Update progress periodically to avoid excessive re-renders
      if ((i + 1) % 50 === 0 || i === docs.length - 1) {
        setProgress({ processed: i + 1, total })
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
      setProgress(null)
      await loadFromScanner()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reload files')
    } finally {
      setLoading(false)
    }
  }

  // Coalesce a burst of incremental changes into a single re-render.
  function scheduleVersionBump() {
    if (versionBumpTimerRef.current) clearTimeout(versionBumpTimerRef.current)
    versionBumpTimerRef.current = setTimeout(() => setVersion(v => v + 1), 100)
  }

  // Incrementally apply a single file change through the shared registry logic:
  // reindex the changed file and revalidate it plus everything that depends on it
  // (derivation, instantiation, $ref/allOf, GTS-id references). This is the same
  // revalidation the VS Code extension performs, so behavior is identical across
  // Web, Electron and VS Code.
  async function applyIncrementalChange(change: FileChange) {
    const scanner = scannerRef.current
    const registry = registryRef.current
    if (!scanner) return
    const { type, doc } = change
    try {
      if (type === 'unlink') {
        await registry.applyFileChange(doc.path, doc.name, null, AppConfig.get().gts)
      } else {
        const text = await scanner.read(doc.path)
        const isYaml = doc.name.endsWith('.yaml') || doc.name.endsWith('.yml')
        let content: any
        try {
          content = isYaml ? parseYAML(text) : parseJSONC(text)
        } catch {
          // Surface parse errors only for files that look GTS-related; ignore
          // unrelated malformed JSON (matches loadFromScanner's filter).
          content = text.includes('gts.') ? text : null
        }
        await registry.applyFileChange(doc.path, doc.name, content, AppConfig.get().gts)
      }
      scheduleVersionBump()
    } catch (err) {
      console.error('Failed to revalidate after file change:', err)
    }
  }

  // Watch for file changes and revalidate incrementally to keep registry/layout
  // in sync (dependent types/instances are revalidated too, not just the file
  // that changed).
  function startWatching() {
    const scanner = scannerRef.current
    if (!scanner) return

    // Stop any existing watcher
    if (watcherRef.current) {
      watcherRef.current()
    }

    // Start new watcher
    watcherRef.current = scanner.watch(
      { glob: '**/*.{json,jsonc,gts,yaml,yml}' },
      (change) => {
        console.log('File change detected:', change)
        // Serialize changes so each validates against a fully-updated registry.
        changeQueueRef.current = changeQueueRef.current.then(() => applyIncrementalChange(change))
      }
    )
  }

  // Cleanup watcher and pending timers on unmount
  React.useEffect(() => {
    return () => {
      if (watcherRef.current) {
        watcherRef.current()
      }
      if (versionBumpTimerRef.current) {
        clearTimeout(versionBumpTimerRef.current)
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
    progress,
  })
}

// Web-specific hook that uses WebSmartScanner (auto-detects browser support)
export function useJsonObjs() {
  return useJsonObjsWithScanner(() => new WebSmartScanner())
}
