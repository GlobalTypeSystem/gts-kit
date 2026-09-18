import React from 'react'
import { JsonRegistry } from '@gts/shared'
import type { ValidationRelayPayload } from '@gts/shared'
import { AppConfig } from '@/lib/config'
import { ViewerModel } from './viewerModel'

/**
 * VS Code-specific hook that auto-scans workspace on mount
 * Listens for scan events from VS Code extension and builds entities
 */
export function useJsonObjsVscode() {
  const [loading, setLoading] = React.useState<boolean>(true)
  const [error, setError] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<{ processed: number; total: number } | null>(null)
  const [initialSelectedId, setInitialSelectedId] = React.useState<string | null>(null)
  const [version, setVersion] = React.useState<number>(0)

  const registryRef = React.useRef<JsonRegistry>(new JsonRegistry())
  const hasInitiallySelectedRef = React.useRef<boolean>(false)
  const pendingSelectFileRef = React.useRef<string | null>(null)
  // The webview runs under a CSP that blocks Ajv's code generation, so the
  // extension host computes validation and relays it via `gts-validation-result`.
  // That message and the (async) `gts-scan-result` ingest race: if validation
  // arrives while `ingestFiles` is still populating the registry, the entity
  // lookups miss and the errors would be lost forever. Keep the latest payload
  // so it can be (re)applied once ingest has finished.
  const pendingValidationRef = React.useRef<ValidationRelayPayload | null>(null)

  // Merge host-computed validation onto the current registry entities (matched
  // by id / path). Safe to call repeatedly; missing entities are skipped.
  const applyValidation = React.useCallback((payload: ValidationRelayPayload | null): boolean => {
    if (!payload) return false
    const reg = registryRef.current
    let applied = false
    for (const o of payload.objs || []) {
      const ent = reg.jsonObjs.get(o.id) as any
      if (ent && o.validation) { ent.validation = o.validation; applied = true }
    }
    for (const s of payload.schemas || []) {
      const ent = reg.jsonSchemas.get(s.id) as any
      if (ent && s.validation) { ent.validation = s.validation; applied = true }
    }
    for (const f of payload.invalidFiles || []) {
      const ent = reg.invalidFiles.get(f.path) as any
      if (ent && f.validation) { ent.validation = f.validation; applied = true }
    }
    return applied
  }, [])

  // Helper function to find and select entity from a file path
  const selectEntityFromFile = React.useCallback((filePath: string) => {
    const registry = registryRef.current
    const objsFromFile = Array.from(registry.jsonObjs.values()).filter(e => e.file?.path === filePath)
    const firstJsonObj = objsFromFile.find(e => e.listSequence === undefined || e.listSequence === 0) || objsFromFile[0]
    if (firstJsonObj) { setInitialSelectedId(firstJsonObj.id); return }
    const schemasFromFile = Array.from(registry.jsonSchemas.values()).filter(e => e.file?.path === filePath)
    const firstSchema = schemasFromFile.find(e => e.listSequence === undefined || e.listSequence === 0) || schemasFromFile[0]
    if (firstSchema) setInitialSelectedId(firstSchema.id)
  }, [])

  const buildEntities = React.useCallback(async (files: Array<{ path: string; name: string; content: any }>, defaultFilePath?: string | null) => {
    const registry = registryRef.current
    registry.reset()
    await registry.ingestFiles(files, AppConfig.get().gts)
    try { (registry as any).setDefaultFile?.(defaultFilePath) } catch {}
    // Registry is now populated: (re)apply any host validation that arrived
    // before/while this ingest was running (see pendingValidationRef).
    applyValidation(pendingValidationRef.current)
    setVersion(v => v + 1)

    const defaultPath = (registry as any).getDefaultFilePath?.()
    if (defaultPath && !hasInitiallySelectedRef.current) {
      hasInitiallySelectedRef.current = true
      setTimeout(() => selectEntityFromFile(defaultPath), 0)
    }

    // If there was a pending explicit selection from the extension, apply it now
    if (pendingSelectFileRef.current) {
      const target = pendingSelectFileRef.current
      pendingSelectFileRef.current = null
      setTimeout(() => selectEntityFromFile(target), 0)
    }
  }, [selectEntityFromFile, applyValidation])

  // Listen for scan events and trigger scan on mount
  React.useEffect(() => {
    function onStarted(e: any) {
      const total = e?.detail?.total || 0
      setLoading(true)
      setError(null)
      setProgress({ processed: 0, total })
    }
    function onProgress(e: any) {
      const { processed, total } = e?.detail || {}
      if (typeof processed === 'number' && typeof total === 'number') setProgress({ processed, total })
    }
    // Scan result handler: builds registry and computes initial selection
    async function onResult(e: any) {
      const files = e?.detail?.files || []
      const defaultFilePath = e?.detail?.defaultFilePath || null
      // A fresh scan invalidates the previous scan's validation; the host always
      // follows a scan-result with a matching validation-result for this set.
      pendingValidationRef.current = null
      try {
        await buildEntities(files, defaultFilePath)
      } finally {
        setLoading(false)
      }
    }
    function onError(e: any) {
      const err = e?.detail?.error || 'Failed to scan workspace'
      setError(err)
      setLoading(false)
    }

    window.addEventListener('gts-scan-started' as any, onStarted)
    window.addEventListener('gts-scan-progress' as any, onProgress)
    window.addEventListener('gts-scan-result' as any, onResult)
    window.addEventListener('gts-scan-error' as any, onError)

    // Handle explicit selection requests from the VS Code extension
    function onSelectFile(e: any) {
      const filePath = e?.detail?.filePath as string | null
      if (!filePath) return
      const reg = registryRef.current
      const hasData = reg.jsonObjs.size > 0 || reg.jsonSchemas.size > 0 || reg.jsonFiles.size > 0
      if (hasData) {
        // Registry is ready: select immediately
        setTimeout(() => selectEntityFromFile(filePath), 0)
      } else {
        // Defer selection until after ingest completes
        pendingSelectFileRef.current = filePath
      }
    }
    window.addEventListener('gts-select-file' as any, onSelectFile)

    function onValidationResult(e: any) {
      const payload = (e?.detail || null) as ValidationRelayPayload | null
      // Buffer so it can be re-applied if the scan-result ingest is still in
      // flight (the two messages race), then apply against whatever is ready now.
      pendingValidationRef.current = payload
      applyValidation(payload)
      setVersion(v => v + 1)
    }

    function onValidationError(e: any) {
      // no-op; optional logging
      console.log('[GTS Hook] Received gts-validation-error event:', e)
    }

    window.addEventListener('gts-validation-result' as any, onValidationResult)
    window.addEventListener('gts-validation-error' as any, onValidationError)

    // Kick off scan for .json, .jsonc and .gts files
    try {
      (window as any).__GTS_APP_API__?.scanWorkspaceJson?.({ include: '**/*.{json,jsonc,gts,yaml,yml}' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to initiate scan')
      setLoading(false)
    }

    return () => {
      window.removeEventListener('gts-scan-started' as any, onStarted)
      window.removeEventListener('gts-scan-progress' as any, onProgress)
      window.removeEventListener('gts-scan-result' as any, onResult)
      window.removeEventListener('gts-scan-error' as any, onError)
      window.removeEventListener('gts-validation-result' as any, onValidationResult)
      window.removeEventListener('gts-validation-error' as any, onValidationError)
      window.removeEventListener('gts-select-file' as any, onSelectFile)
    }
  }, [buildEntities, applyValidation])

  // Refresh from webview: ask the extension to rescan; SharedApp coordinates viewport/entity restoration
  const reload = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    setProgress(null)
    try {
      (window as any).__GTS_APP_API__?.scanWorkspaceJson?.({ include: '**/*.{json,jsonc,gts,yaml,yml}' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to initiate scan')
      setLoading(false)
    }
  }, [])

  const chooseDirectory = React.useCallback(async () => {
    // VS Code does not prompt for a directory
  }, [])

  return new ViewerModel({
    registry: registryRef.current,
    version,
    loading,
    error,
    reload,
    chooseDirectory,
    needsDirectory: false,
    progress,
    initialSelectedId,
  })
}
