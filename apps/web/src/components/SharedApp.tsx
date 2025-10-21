import React, { useRef, useState, useEffect, useMemo } from 'react'
import { EntityList } from './EntitiesListMenu'
import { SchemaDiagram, type SchemaDiagramHandle } from './SchemaDiagram'
import { JsonObj, JsonSchema, JsonFile } from '@gts/shared'
import { SchemaInvalidFileModel } from './SchemaInvalidFileModel'
import { SchemaInvalidFileView } from './SchemaInvalidFileView'
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { debug } from '@/lib/debug'
import { TIMING } from '@/lib/timing'
import { AppConfig } from '@/lib/config'
import { ViewerModel } from '@/hooks/viewerModel'
import { useServerHealth } from '@/hooks/useServerHealth'
import { diagramRegistry } from '@/lib/diagramRegistry'

interface SharedAppProps {
  model: ViewerModel
  directorySelectionText?: string
  isVSCode?: boolean
}

export function SharedApp({
  model,
  directorySelectionText = "Choose a directory containing JSON files (and optional schemas). Files are scanned locally using your browser.",
  isVSCode = false
}: SharedAppProps) {
  const jsonObjs = useMemo(() => model.getJsonObjs(), [model.version])
  const schemas = useMemo(() => model.getJsonSchemas(), [model.version])
  const invalidFiles = useMemo(() => model.getInvalidFiles(), [model.version])
  const loading = model.loading
  const error = model.error
  const progress = model.progress ?? null
  const needsDirectory = model.needsDirectory
  const reload = model.reload
  const chooseDirectory = model.chooseDirectory
  const initialSelectedId = model.initialSelectedId ?? null
  const [selectedEntity, setselectedEntity] = useState<JsonObj | JsonSchema | null>(null)
  const [selectedInvalidFile, setSelectedInvalidFile] = useState<JsonFile | null>(null)
  const [diagramEntity, setDiagramEntity] = useState<JsonObj | JsonSchema | null>(null)
  const diagramUpdateTimerRef = useRef<number | null>(null)
  // Keep hooks order stable across renders: declare all hooks before any early returns
  const config = AppConfig.get()
  const MIN_SIDEBAR_WIDTH = config.sidebar.min_width
  const MAX_SIDEBAR_WIDTH = config.sidebar.max_width
  const DEFAULT_SIDEBAR_WIDTH = config.sidebar.default_width

  // Server health monitoring
  const { status: serverStatus, markUnhealthy, serverUrl, usesServerBackend } = useServerHealth()

  // Load sidebar width from localStorage (with fallback for environments where localStorage is not available)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('gts-sidebar-width')
      return saved ? parseInt(saved, 10) : DEFAULT_SIDEBAR_WIDTH
    } catch (e) {
      // localStorage not available (e.g., VSCode webview)
      return DEFAULT_SIDEBAR_WIDTH
    }
  })
  // Hide sidebar by default in VSCode mode
  const [sidebarOpen, setSidebarOpen] = useState(!isVSCode)
  const [isResizing, setIsResizing] = useState(false)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const diagramRef = useRef<SchemaDiagramHandle | null>(null)
  // Track filtered entities from EntitiesListMenu for keyboard navigation
  const [filteredEntities, setFilteredEntities] = useState<Array<JsonObj | JsonSchema | JsonFile>>([])

  // Auto-select entity when initialSelectedId becomes available (VSCode initial scan)
  useEffect(() => {
    const id = initialSelectedId
    if (!id) return
    const reg = model.registry
    const entity = (reg.jsonObjs.get(id) as any) || (reg.jsonSchemas.get(id) as any)
    if (entity) {
      setselectedEntity(entity)
      setDiagramEntity(entity)
    }
  }, [initialSelectedId])

  // Save sidebar width to localStorage whenever it changes (with fallback for environments where localStorage is not available)
  useEffect(() => {
    try {
      localStorage.setItem('gts-sidebar-width', sidebarWidth.toString())
    } catch (e) {
      // localStorage not available (e.g., VSCode webview), skip saving
    }
  }, [sidebarWidth])

  // Handle resize drag
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsResizing(true)
  }

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, e.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Handle file selection - let SchemaDiagram handle the dirty state reset
  const handleEntitySelect = (entity: JsonObj | JsonSchema) => {
    setselectedEntity(entity)
    setSelectedInvalidFile(null)
    // Debounce diagram updates so rapid navigation doesn't thrash
    if (diagramUpdateTimerRef.current !== null) {
      clearTimeout(diagramUpdateTimerRef.current)
    }
    diagramUpdateTimerRef.current = window.setTimeout(() => {
      setDiagramEntity(entity)
      diagramUpdateTimerRef.current = null
    }, 50)
  }

  const handleInvalidFileSelect = (file: JsonFile) => {
    setSelectedInvalidFile(file)
    setselectedEntity(null)
    setDiagramEntity(null)
  }

  // Global keyboard navigation: Shift + ArrowUp/ArrowDown switches entities
  // Uses filtered entities from EntitiesListMenu to respect search and collapsed sections
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs/textareas/contentEditable
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        const editable = (target as any).isContentEditable
        if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return
      }

      // Use Shift key instead of Cmd/Ctrl for safer navigation
      if (!e.shiftKey) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      e.stopPropagation()

      // Use filtered entities from EntitiesListMenu (respects search and collapsed sections)
      const list = filteredEntities
      if (list.length === 0) return

      // Find current index, checking both entities and invalid files
      let curIndex = -1
      if (selectedEntity) {
        curIndex = list.findIndex(x => 'id' in x && x.id === selectedEntity.id)
      } else if (selectedInvalidFile) {
        curIndex = list.findIndex(x => 'path' in x && 'validation' in x && (x as JsonFile).path === selectedInvalidFile.path)
      }

      let nextIndex = curIndex
      if (e.key === 'ArrowDown') {
        nextIndex = curIndex < 0 ? 0 : Math.min(curIndex + 1, list.length - 1)
      } else {
        nextIndex = curIndex < 0 ? list.length - 1 : Math.max(curIndex - 1, 0)
      }
      const next = list[nextIndex]
      if (next) {
        // Check if it's a JsonFile (invalid file) or an entity
        if ('isSchema' in next) {
          // It's a JsonObj or JsonSchema
          if (next !== selectedEntity) {
            handleEntitySelect(next as JsonObj | JsonSchema)
          }
        } else {
          // It's a JsonFile (invalid file)
          if (next !== selectedInvalidFile) {
            handleInvalidFileSelect(next as JsonFile)
          }
        }
      }
    }

    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true } as any)
  }, [filteredEntities, selectedEntity, selectedInvalidFile, handleEntitySelect, handleInvalidFileSelect])

  // Refresh everything: reload files from disk/server and rebuild diagram
  const handleRefreshEverything = async () => {
    if (!diagramRef.current) {
      // If no diagram is available, just do a simple reload
      await reload()
      return
    }

    try {
      // Use the centralized refresh from SchemaDiagram
      const { rememberedEntity, restoreViewport } = await diagramRef.current.refresh(reload)

      // Clear current selection to force re-render
      setselectedEntity(null)

      // Step 3: Restore the remembered entity and viewport after reload completes
      if (rememberedEntity) {
        debug.refresh('Restoring remembered entity:', rememberedEntity.id)
        // Wait for the next tick to ensure state updates have propagated
        setTimeout(() => {
          // Find the entity with the same ID in the newly loaded data
          const restoredEntity = [...jsonObjs, ...schemas].find(entity => entity.id === rememberedEntity.id)

          if (restoredEntity) {
            debug.refresh('Restoring entity:', restoredEntity.id)
            setselectedEntity(restoredEntity)
            setDiagramEntity(restoredEntity)

            // Apply remembered viewport and maximized states after the diagram is rendered
            setTimeout(() => {
              restoreViewport()
            }, TIMING.VIEWPORT_RESTORE_DELAY)
          } else {
            debug.refresh('Could not find remembered entity after reload:', rememberedEntity.id)
          }
        }, TIMING.STATE_PROPAGATION_DELAY)
      }
    } catch (error) {
      debug.refresh('Error during refresh:', error)
      // Fallback to simple reload
      await reload()
    }
  }

  // Refresh only the diagram layout: reload saved layout from storage without reloading files
  const handleRefreshLayout = () => {
    if (!diagramEntity) {
      // No diagram to refresh
      return
    }

    console.log('[SharedApp.handleRefreshLayout] Reloading saved layout from storage (no file reload)')

    // Store the current entity
    const currentEntity = diagramEntity

    // Clear the diagram from cache - this will force it to reload from snapshot on next render
    diagramRegistry.delete(currentEntity.id)
    console.log('[SharedApp.handleRefreshLayout] Cleared diagram cache for', currentEntity.id)

    // Clear the diagram to unmount it
    setDiagramEntity(null)
    setselectedEntity(null)

    // Wait for unmount, then re-mount with the same entity
    // This will trigger loading from the saved snapshot
    setTimeout(() => {
      console.log('[SharedApp.handleRefreshLayout] Re-mounting diagram, will load from snapshot')
      setDiagramEntity(currentEntity)
      setselectedEntity(currentEntity)
    }, 50)
  }

  // Auto-refresh layout when VS Code extension signals a refresh
  useEffect(() => {
    const onRefreshLayout = (e: any) => {
      const filePath = e?.detail?.filePath as string | undefined
      if (!filePath) {
        // Fallback: refresh current diagram only
        handleRefreshLayout()
        return
      }

      // Invalidate cached diagrams for all entities associated with the given file
      const reg = model.registry
      const idsToInvalidate: string[] = []
      reg.jsonObjs.forEach((o) => { if (o.file?.path === filePath) idsToInvalidate.push(o.id) })
      reg.jsonSchemas.forEach((s) => { if (s.file?.path === filePath) idsToInvalidate.push(s.id) })

      idsToInvalidate.forEach((id) => diagramRegistry.delete(id))

      // If the currently displayed diagram belongs to that file, refresh it now
      const currentFilePath = (diagramEntity as any)?.file?.path as string | undefined
      if (currentFilePath && currentFilePath === filePath) {
        handleRefreshLayout()
      }
    }
    window.addEventListener('gts-refresh-layout' as any, onRefreshLayout)
    return () => window.removeEventListener('gts-refresh-layout' as any, onRefreshLayout)
  }, [handleRefreshLayout, model.registry, diagramEntity])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="flex flex-col items-center space-y-4">
          <div className="flex items-center space-x-2">
            <Loader2 className="h-6 w-6 animate-spin animate-in fade-in duration-300" style={{ animationDelay: '200ms', opacity: 0, animationFillMode: 'forwards' }} />
            <span className="animate-in fade-in duration-300" style={{ animationDelay: '200ms', opacity: 0, animationFillMode: 'forwards' }}>
              Scanning workspace for JSON and GTS files...
            </span>
          </div>
          {progress && progress.total > 0 && (
            <div className="w-80">
              <div className="flex justify-between text-sm text-muted-foreground mb-1">
                <span>Processing files...</span>
                <span>{progress.processed} / {progress.total}</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.processed / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6">
            <div className="flex items-center space-x-2 text-red-600 mb-4">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">Error loading files</span>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{error}</p>
            <Button onClick={reload} className="w-full">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (needsDirectory) {
    return (
      <div className="h-screen flex items-center justify-center p-6">
        <Card className="max-w-xl w-full shadow-sm">
          <CardContent className="pt-8 pb-8">
            <div className="text-center space-y-4">
              <h1 className="text-3xl font-bold">GTS Viewer</h1>
              <p className="text-muted-foreground">Visualize JSON files and their schema relationships</p>
              <div>
                <Button onClick={chooseDirectory} className="inline-flex items-center">
                  <span className="mr-2">📁</span>
                  Select Directory
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {directorySelectionText}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="h-screen flex bg-background">
      {/* Left Sidebar */}
      <div
        className="border-r bg-card overflow-hidden transition-all"
        style={{
          width: sidebarOpen ? `${sidebarWidth}px` : '0px',
          minWidth: sidebarOpen ? `${sidebarWidth}px` : '0px',
          maxWidth: sidebarOpen ? `${sidebarWidth}px` : '0px'
        }}
      >
        <EntityList
          jsonObjs={jsonObjs}
          schemas={schemas}
          invalidFiles={invalidFiles}
          selectedEntity={selectedEntity}
          selectedInvalidFile={selectedInvalidFile}
          onEntitySelect={handleEntitySelect}
          onInvalidFileSelect={handleInvalidFileSelect}
          onRefresh={handleRefreshEverything}
          onOpen={chooseDirectory}
          onFilteredEntitiesChange={setFilteredEntities}
        />
      </div>

      {/* Resize Handle */}
      {sidebarOpen && (
        <div
          className="w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/40 transition-colors relative group"
          onMouseDown={handleMouseDown}
          style={{ userSelect: 'none' }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="border-b bg-card px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <button
                className="p-2 rounded border hover:bg-accent"
                aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                onClick={() => setSidebarOpen(o => !o)}
              >
                {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <div>
                <h1 className="text-2xl font-bold">GTS Types and Instances Viewer</h1>
                <p className="text-sm text-muted-foreground">
                  {diagramEntity ? (diagramEntity.label) : 'Visualize JSON files and their schema relationships based on GTS IDs'}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {usesServerBackend && serverStatus === 'unhealthy' && (
                <div className="flex items-center justify-end space-x-2 text-sm text-amber-600 dark:text-amber-500 ml-auto">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Reconnecting to server<br/>{serverUrl} ...</span>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshLayout}
                title="Refresh diagram layout"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!layoutDirty || !diagramEntity || (usesServerBackend && serverStatus === 'unhealthy')}
                onClick={() => diagramRef.current?.save(markUnhealthy)}
                className={usesServerBackend && serverStatus === 'unhealthy' ? 'opacity-40 cursor-not-allowed' : ''}
                title={
                  usesServerBackend && serverStatus === 'unhealthy'
                    ? 'Server is unavailable. Reconnecting...'
                    : !layoutDirty
                      ? 'No changes to save'
                      : !diagramEntity
                        ? 'Select an entity first'
                        : 'Save layout changes'
                }
              >
                Save Layout
              </Button>
            </div>
          </div>
        </div>

        {/* Diagram or Invalid File View */}
        <div className="flex-1">
          {selectedInvalidFile ? (
            <div className="h-full p-4 overflow-hidden">
              <SchemaInvalidFileView
                model={new SchemaInvalidFileModel(selectedInvalidFile)}
                onClose={() => setSelectedInvalidFile(null)}
              />
            </div>
          ) : jsonObjs.length > 0 || schemas.length > 0 ? (
            diagramEntity ? (
              <SchemaDiagram
                ref={diagramRef}
                jsonSchemas={schemas}
                selectedEntity={diagramEntity}
                jsonObjs={jsonObjs}
                dataVersion={model.version}
                onDirtyChange={setLayoutDirty}
                registry={model.registry}
                isVSCode={isVSCode}
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="text-6xl mb-4">👈</div>
                  <h3 className="text-lg font-medium mb-2">Select a JSON file</h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    Choose a JSON file from the left panel to view its schema relationships and properties.
                  </p>
                </div>
              </div>
            )
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="text-6xl mb-4">📄</div>
                <h3 className="text-lg font-medium mb-2">No JSON files found</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Make sure you have JSON files in your selected directory.
                </p>
                <Button onClick={reload} className="mt-4">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Global bottom hint footer (always visible) */}
      <div
        className="fixed bottom-0 left-0 right-0 h-[25px] bg-card border-t px-4 text-xs text-muted-foreground flex items-center z-50"
        aria-hidden="false"
      >
        <span>Tip: Use Shift + Arrow Up/Down to navigate</span>
      </div>
    </div>
  )
}
