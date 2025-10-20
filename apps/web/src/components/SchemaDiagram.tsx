import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import ReactFlow, {
  useNodesState,
  useEdgesState,
  ReactFlowInstance,
  Connection,
  Controls,
  Background,
  BackgroundVariant,
  Viewport,
  NodeChange,
  EdgeChange,
  Node as RFNode,
  Edge as RFEdge,
} from 'reactflow'
// no icon imports needed here
import { getLatestLayout, saveLayout, getApiBase, ApiCanvasState, ApiLayoutSnapshot, ApiLayoutNode, ApiLayoutEdge } from '@/utils/api'
import { SchemaNodeView } from './SchemaNodeView'
import type { SchemaNodeModel } from './SchemaNodeModel'
import type { SchemaEdgeModel } from './SchemaEdgeModel'
import EdgeView from './SchemaEdgeView'
import { Toast, type ToastType } from './ui/toast'
import { JsonObj, JsonSchema, JsonRegistry } from '@gts/shared'
// Node presentation is handled inside SchemaNodeView
import { DiagramModel } from './DiagramModel'
import { AppConfig } from '@/lib/config'
import { debug } from '@/lib/debug'
import { diagramRegistry } from '@/lib/diagramRegistry'
import { apiHandleToId } from '@/lib/handleUtils'
import { TIMING } from '@/lib/timing'

import 'reactflow/dist/style.css'

// Define nodeTypes/edgeTypes once and persist across HMR to avoid React Flow error 002
const g: any = (globalThis as any) || {}

// Always set to ensure updates across HMR
g.__GTS_VIEWER_NODE_TYPES__ = { schemaNode: SchemaNodeView }
if (!g.__GTS_VIEWER_EDGE_TYPES__) {
  g.__GTS_VIEWER_EDGE_TYPES__ = { custom: EdgeView }
}
const NODE_TYPES = g.__GTS_VIEWER_NODE_TYPES__ as { schemaNode: typeof SchemaNodeView }
const EDGE_TYPES = g.__GTS_VIEWER_EDGE_TYPES__ as { custom: typeof EdgeView }

// Global state is now managed by diagramRegistry

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

const VIEWPORT_STABILIZATION_DELAY = TIMING.VIEWPORT_INIT_DELAY
const FIT_VIEW_RENDER_DELAY = TIMING.FIT_VIEW_DELAY
const VIEWPORT_TRANSITION_DURATION = TIMING.VIEWPORT_TRANSITION_DURATION

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getCanonicalNodeModel(node: RFNode, diagram: DiagramModel): SchemaNodeModel | undefined {
  return diagram.getNodeModel(node.id) ?? (node.data?.model as SchemaNodeModel | undefined)
}

function getCanonicalEdgeModel(edge: RFEdge, diagram: DiagramModel): SchemaEdgeModel | undefined {
  return diagram.getEdgeModel(edge.id) ?? (edge.data?.model as SchemaEdgeModel | undefined)
}

function enrichNodesWithHandlers(
  nodes: RFNode[],
  diagram: DiagramModel,
  handlers: {
    onNodeChange: () => void
    onMaximize: (value: boolean) => void
    onMaximizeRawJson: (value: boolean) => void
  },
  overlayContainer: React.RefObject<HTMLDivElement>,
  selectedEntity: JsonObj | JsonSchema | null,
  registry?: JsonRegistry | null
): RFNode[] {
  return nodes.map((node) => {
    const canonicalModel = diagram.getNodeModel(node.id)
    debug.layout(`Creating node ${node.id}: diagram position (${node.position.x}, ${node.position.y}), model position (${canonicalModel?.position.x}, ${canonicalModel?.position.y})`)
    return {
      ...node,
      data: {
        ...node.data,
        model: canonicalModel,
        onNodeChange: handlers.onNodeChange,
        onMaximize: handlers.onMaximize,
        onMaximizeRawJson: handlers.onMaximizeRawJson,
        overlayContainer,
        rootNodeId: selectedEntity?.id,
        registry,
      },
    }
  })
}

function enrichEdgesWithHandlers(
  edges: RFEdge[],
  onEdgeChange: () => void
): RFEdge[] {
  return edges.map((edge) => ({
    ...edge,
    data: {
      ...edge.data,
      onEdgeChange,
    },
  }))
}

// ============================================================================
// CUSTOM HOOKS
// ============================================================================

function useDirtyState(diagram: DiagramModel, onDirtyChange?: (dirty: boolean) => void) {
  const [isDirty, setIsDirty] = useState(false)

  const markDirty = useCallback(() => {
    const currentDirtyState = diagram.isDirty()
    setIsDirty(currentDirtyState)
    onDirtyChange?.(currentDirtyState)
  }, [diagram, onDirtyChange])

  const resetDirty = useCallback(() => {
    setIsDirty(false)
    onDirtyChange?.(false)
  }, [onDirtyChange])

  return { isDirty, markDirty, setIsDirty, resetDirty }
}

function useViewportManager(
  diagram: DiagramModel,
  selectedEntity: JsonObj | JsonSchema | null,
  currentEntityIdRef: React.MutableRefObject<string | null>
) {
  const baselineViewportRef = useRef<Viewport | null>(null)

  const handleViewportChange = useCallback((viewport: Viewport) => {
    debug.viewport('handleViewportChange', {
      viewport,
      baseline: baselineViewportRef.current,
      zoomLevel: viewport.zoom,
      zoomDirection: baselineViewportRef.current ? (viewport.zoom > baselineViewportRef.current.zoom ? 'IN' : 'OUT') : 'UNKNOWN',
      currentEntityId: currentEntityIdRef.current,
      selectedEntityId: selectedEntity?.id
    })

    // Reject stale events from unmounting instances during entity transitions
    if (selectedEntity && currentEntityIdRef.current !== selectedEntity.id) {
      debug.viewport('handleViewportChange: suppressed (stale entity)', currentEntityIdRef.current, '!=', selectedEntity.id)
      return
    }

    diagram.updateViewport(viewport)
  }, [diagram, selectedEntity, currentEntityIdRef])

  const initializeViewport = useCallback((viewport: Viewport) => {
    if (!baselineViewportRef.current) {
      baselineViewportRef.current = viewport
    }
  }, [])

  const setBaselineViewport = useCallback((viewport: Viewport) => {
    baselineViewportRef.current = { ...viewport }
  }, [])

  const resetViewport = useCallback(() => {
    baselineViewportRef.current = null
  }, [])

  return {
    handleViewportChange,
    baselineViewportRef,
    initializeViewport,
    setBaselineViewport,
    resetViewport
  }
}

// ============================================================================
// COMPONENT DEFINITION
// ============================================================================

interface SchemaDiagramProps {
  selectedEntity: JsonObj | JsonSchema
  jsonSchemas?: JsonSchema[]
  jsonObjs?: JsonObj[]
  onDirtyChange?: (dirty: boolean) => void
  dataVersion?: number
  registry?: JsonRegistry | null
}

export type SchemaDiagramHandle = {
  save: (onServerError?: () => void) => Promise<void>
  rfInstance: ReactFlowInstance | null
  refresh: (reloadFn: () => Promise<void>) => Promise<{
    rememberedEntity: JsonObj | JsonSchema | null
    rememberedViewport: Viewport | null
    restoreViewport: () => void
  }>
}

export const SchemaDiagram = forwardRef<SchemaDiagramHandle, SchemaDiagramProps>(
  ({ selectedEntity, jsonSchemas, jsonObjs = [], onDirtyChange = () => {}, dataVersion = 0, registry = null }: SchemaDiagramProps, ref) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const [nodesAreReady, setNodesAreReady] = useState(false)
  const [toast, setToast] = useState<{ message: string | React.ReactNode; type: ToastType; duration: number } | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const initialEdgesAppliedRef = useRef(false)
  const overlayContainerRef = useRef<HTMLDivElement | null>(null)
  const prevSelectedIdRef = useRef<string | null>(null)
  const currentEntityIdRef = useRef<string | null>(null)

  const onConnect = useCallback(
    (params: Connection) => {
      // Connection handling can be implemented if needed
      console.log('Connection:', params)
    },
    []
  )

  const handleMaximizeNode = useCallback((isMaximized: boolean) => {
    debug.diagram('handleMaximizeNode', isMaximized)
    diagramRegistry.setMaximized(isMaximized)
    setIsMaximized(isMaximized)
  }, [])

  const handleMaximizeNodeRawJson = useCallback((isRawView: boolean) => {
    debug.diagram('handleMaximizeNodeRawJson', isRawView)
    diagramRegistry.setRawViewPreference(isRawView)
  }, [])

  function getOrCreateDiagram(): DiagramModel {
    if (!selectedEntity) return new DiagramModel(selectedEntity, jsonSchemas || [], jsonObjs || [], diagramRegistry.getViewState())

    let d = diagramRegistry.get(selectedEntity.id)

    if (d) {
      debug.diagram(`Reusing layout for ${selectedEntity.id}`)

      // Always apply current global view state to the root node when reusing a diagram
      const viewState = diagramRegistry.getViewState()
      const rootNode = d.getNodeModel(selectedEntity.id)
      if (rootNode) {
        rootNode.isMaximized = viewState.hasAnyMaximizedEntity
        debug.diagram(`Updated root node ${selectedEntity.id} with global state: maximized=${viewState.hasAnyMaximizedEntity}, rawView=${viewState.globalRawViewPreference}`)
      }

      d.refresh()
      return d
    }

    // For new diagrams, apply global view preferences
    const viewState = diagramRegistry.getViewState()
    const shouldExpandRoot = viewState.hasAnyMaximizedEntity
    const shouldUseRawView = viewState.globalRawViewPreference

    debug.diagram(`Creating new diagram for ${selectedEntity.id} with global preferences: expanded=${shouldExpandRoot}, rawView=${shouldUseRawView}`)

    d = new DiagramModel(selectedEntity, jsonSchemas || [], jsonObjs || [], diagramRegistry.getViewState())
    diagramRegistry.set(selectedEntity.id, d)

    debug.diagram(`Created new layout for ${selectedEntity.id}: ${d.nodes.length} nodes and ${d.edges.length} edges`)
    return d
  }

  // Create nodes and edges based on selected entity using DiagramLayout
  const diagram = useMemo(() => {
    return getOrCreateDiagram()
  }, [selectedEntity?.id, dataVersion])

  // Custom hooks for state management
  const { isDirty, markDirty, setIsDirty } = useDirtyState(diagram, onDirtyChange)
  const {
    handleViewportChange,
    initializeViewport,
    setBaselineViewport,
    resetViewport
  } = useViewportManager(diagram, selectedEntity, currentEntityIdRef)

  const handleNodeChange = useCallback(() => {
    debug.diagram('handleNodeChange')
    markDirty()
  }, [markDirty])

  const handleEdgeChange = useCallback(() => {
    debug.diagram('handleEdgeChange')
    markDirty()
  }, [markDirty])

  // Update React Flow state when layout changes
  useEffect(() => {
    debug.layout('New layout calculated, applying nodes and edges.')

    const nodesWithHandlers = enrichNodesWithHandlers(
      diagram.nodes,
      diagram,
      {
        onNodeChange: handleNodeChange,
        onMaximize: handleMaximizeNode,
        onMaximizeRawJson: handleMaximizeNodeRawJson,
      },
      overlayContainerRef,
      selectedEntity,
      registry
    )

    const edgesWithHandlers = enrichEdgesWithHandlers(diagram.edges, handleEdgeChange)

    setNodes(nodesWithHandlers)
    setEdges(edgesWithHandlers)
    setNodesAreReady(diagram.nodes.length > 0)

    // Update dirty state after diagram is rendered
    const currentDirtyState = diagram.isDirty()
    setIsDirty(currentDirtyState)
    onDirtyChange?.(currentDirtyState)
  }, [diagram, handleNodeChange, handleEdgeChange, handleMaximizeNode, handleMaximizeNodeRawJson, selectedEntity, onDirtyChange])

  // Wrap changes to mark dirty on user edits
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes)
    markDirty()
  }, [onNodesChange, markDirty])

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes)
    markDirty()
  }, [onEdgesChange, markDirty])

  // Use diagram methods for building payloads (removed local implementations)

  const getViewportData = useCallback((rfInstance: ReactFlowInstance): ApiCanvasState => {
    const viewport = rfInstance.getViewport()
    return { scale: viewport.zoom, pan: { x: viewport.x, y: viewport.y } }
  }, [])

  const resetDirtyState = useCallback(() => {
    diagram.resetDirtyBaseline()
    setIsDirty(false)
    onDirtyChange?.(false)
  }, [diagram, onDirtyChange])

  // Format error messages for common failures
  const formatErrorMessage = useCallback((err: any): string | React.ReactNode => {
    const errMsg = err?.message ? String(err.message) : ''

    // Connection refused
    if (errMsg.includes('Failed to fetch') || errMsg.includes('ERR_CONNECTION_REFUSED') || errMsg.includes('NetworkError')) {
      const apiBase = getApiBase()
      return (
        <>
          Can't connect to the server <strong>{apiBase}</strong>
          <br />
          Ensure it's running
        </>
      )
    }

    // HTTP errors
    if (errMsg.includes('Failed to save layout: ')) {
      const statusMatch = errMsg.match(/Failed to save layout: (\d+)/)
      if (statusMatch) {
        const status = statusMatch[1]
        if (status === '401' || status === '403') {
          return 'Authentication required. Please check your credentials.'
        }
        if (status === '500') {
          return 'Server error. Please try again later.'
        }
        return `Server returned error ${status}`
      }
    }

    // Generic fallback
    return errMsg || 'Failed to save layout'
  }, [])

  // Build payload and save
  const doSave = useCallback(async (onServerError?: () => void) => {
    if (!selectedEntity || !rfInstance || !isDirty) return

    try {
      const canvas = getViewportData(rfInstance)
      const payloadNodes = diagram.buildNodePayload()
      const payloadEdges = diagram.buildEdgePayload()

      const targetFilename = (selectedEntity as any).file?.name || (selectedEntity as any).name || selectedEntity.id
      const targetSchemaId = (selectedEntity as any).schemaId || selectedEntity.id

      await saveLayout({
        target: { id: selectedEntity.id, filename: targetFilename, schemaId: targetSchemaId },
        canvas,
        nodes: payloadNodes,
        edges: payloadEdges,
        meta: { viewer: 'gts-viewer' }
      })

      resetDirtyState()
      setToast({ message: 'Saved', type: 'success', duration: TIMING.SAVE_LAYOUT_SUCCESS_MSG_DURATION })
    } catch (err: any) {
      const message = formatErrorMessage(err)
      setToast({ message, type: 'error', duration: TIMING.SAVE_LAYOUT_ERROR_MSG_DURATION })

      // Check if this is a server connection error and notify parent
      const errMsg = err?.message ? String(err.message) : ''
      if (errMsg.includes('Failed to fetch') || errMsg.includes('ERR_CONNECTION_REFUSED') || errMsg.includes('NetworkError')) {
        onServerError?.()
      }
    }
  }, [selectedEntity, rfInstance, isDirty, diagram, getViewportData, resetDirtyState, formatErrorMessage])

  // Refresh handler used by SharedApp during full refresh:
  // - Remembers currently selected entity and its viewport
  // - Clears diagram cache and awaits the provided reload() to rebuild data/registry
  // - Returns a function to restore the previous viewport after SharedApp re-selects the entity
  const handleRefresh = useCallback(async (reloadFn: () => Promise<void>) => {
    // Step 1: Store currently opened JSON entity and its diagram viewport
    let rememberedEntity: JsonObj | JsonSchema | null = null
    let rememberedViewport: { x: number, y: number, zoom: number } | null = null

    if (selectedEntity && rfInstance) {
      rememberedEntity = selectedEntity

      // Get current viewport from the ReactFlow instance using the actual diagram
      const currentViewport = diagram.getViewport()
      rememberedViewport = {
        x: currentViewport.x,
        y: currentViewport.y,
        zoom: currentViewport.zoom
      }

      debug.refresh('Stored viewport:', rememberedViewport)
      debug.refresh('Stored entity:', rememberedEntity.id)
    }

    // Step 2: Clear diagram cache and regenerate everything
    // Clear the global diagram cache
    diagramRegistry.clear()
    debug.refresh('Cleared diagram cache')

    // Regenerate all files (similar to full files re-read)
    await reloadFn()

    // Step 3: The entity restoration will happen through the normal React lifecycle
    // When new jsonObjs/schemas are loaded, the parent component will need to:
    // 1. Find the entity with the same ID in the newly loaded data
    // 2. Call setSelectedEntity with the restored entity
    // 3. The viewport will be restored via the returned restoration function

    return {
      rememberedEntity,
      rememberedViewport,
      restoreViewport: () => {
        if (rememberedViewport && rfInstance) {
          debug.refresh('Restoring viewport:', rememberedViewport)
          rfInstance.setViewport(rememberedViewport, { duration: VIEWPORT_TRANSITION_DURATION })
        }
      }
    }
  }, [selectedEntity, rfInstance, diagram])

  useImperativeHandle(ref, () => ({
    save: doSave,
    rfInstance: rfInstance,
    refresh: handleRefresh,
  }), [doSave, rfInstance, handleRefresh])

  // Helper functions for applySnapshot
  const canApplySnapshot = useCallback(() => {
    return !!(selectedEntity && rfInstance)
  }, [selectedEntity, rfInstance])

  const loadSnapshotIfNeeded = useCallback(async (): Promise<ApiLayoutSnapshot | null> => {
    if (!selectedEntity) return null

    try {
      return await getLatestLayout({
        id: selectedEntity.id,
        filename: ((selectedEntity as any).file?.name || (selectedEntity as any).name || selectedEntity.id),
        schemaId: ((selectedEntity as any).schemaId || selectedEntity.id)
      })
    } catch (e) {
      debug.layout('loadSnapshotIfNeeded: Error loading snapshot', e)
      return null
    }
  }, [selectedEntity])

  const applyDefaultLayout = useCallback(() => {
    if (!rfInstance) return

    const vp = rfInstance.getViewport()
    setBaselineViewport(vp)

    setTimeout(() => {
      debug.layout('applyDefaultLayout: Applying fitView after nodes are rendered')
      rfInstance.fitView({ padding: AppConfig.get().schema.fit_view.padding })
      setTimeout(() => {
        diagram.initViewport(rfInstance.getViewport())
      }, VIEWPORT_STABILIZATION_DELAY)
    }, FIT_VIEW_RENDER_DELAY)
  }, [rfInstance, diagram, setBaselineViewport])

  const applySnapshotViewport = useCallback((snapshot: ApiLayoutSnapshot) => {
    if (!rfInstance || !snapshot.canvas) return

    const { scale, pan } = snapshot.canvas
    const viewport = { x: pan.x, y: pan.y, zoom: scale }
    rfInstance.setViewport(viewport, { duration: 0 })
    setBaselineViewport(viewport)
    diagram.initViewport(viewport)
  }, [rfInstance, diagram, setBaselineViewport])

  const applySnapshotNodes = useCallback((snapshot: ApiLayoutSnapshot) => {
    setNodes(ns => ns.map((n) => {
      const sn = snapshot.nodes.find((x: ApiLayoutNode) => x.id === n.id)
      if (!sn) return n

      const model = getCanonicalNodeModel(n, diagram)
      if (!model) return n

      const expanded = !!sn.expansion?.expanded
      const sections = sn.expansion?.sections || {}
      const rawView = (sn.extra?.rawView as boolean | undefined) ?? model.rawView

      model.initLayout({ x: sn.position.x, y: sn.position.y }, expanded, rawView ?? false, sections)

      return {
        ...n,
        position: { x: sn.position.x, y: sn.position.y },
        data: { ...n.data, model },
      }
    }))
  }, [diagram, setNodes])

  const applySnapshotEdges = useCallback((snapshot: ApiLayoutSnapshot) => {
    setEdges(es => es.map((e) => {
      const se = snapshot.edges.find((x: ApiLayoutEdge) => x.id === e.id)
      if (!se) return e

      const sourceHandle = apiHandleToId(se.handles?.source)
      const targetHandle = apiHandleToId(se.handles?.target)

      const model = getCanonicalEdgeModel(e, diagram)
      if (model && sourceHandle && targetHandle) {
        model.initHandlers(sourceHandle, targetHandle, se.labelPosition, se.labelOffset)
      }

      return {
        ...e,
        sourceHandle: sourceHandle || e.sourceHandle,
        targetHandle: targetHandle || e.targetHandle,
        data: {
          ...e.data,
          sourceHandle: sourceHandle || e.data?.sourceHandle,
          targetHandle: targetHandle || e.data?.targetHandle,
          labelPosition: se.labelPosition ?? e.data?.labelPosition,
          labelOffset: se.labelOffset ?? e.data?.labelOffset,
          model
        },
      }
    }))
  }, [diagram, setEdges])

  const finalizeSnapshot = useCallback(() => {
    if (!rfInstance) return
    diagram.initViewport(rfInstance.getViewport())
    debug.layout('finalizeSnapshot: Snapshot application complete')
  }, [rfInstance, diagram])

  // Apply layout after selection/init:
  // - If a saved snapshot exists, apply its viewport/nodes/edges
  // - Otherwise, compute and apply a default layout (fitView)
  // Called when RF instance becomes ready and when the selected entity changes
  const applySnapshot = useCallback(async () => {
    debug.layout('applySnapshot: STARTING')

    if (!canApplySnapshot()) return
    debug.layout('applySnapshot: Selected entity', selectedEntity?.id)

    if (diagram.getSnapshotChecked()) {
      const viewport = diagram.getViewport()
      rfInstance?.setViewport(viewport)
      setBaselineViewport(viewport)
      debug.viewport('applySnapshot: Baseline viewport set to', rfInstance?.getViewport())
      return
    }

    const snapshot = await loadSnapshotIfNeeded()
    diagram.setSnapshotChecked(true)

    if (!snapshot) {
      debug.layout('applySnapshot: No snapshot found, drawing default diagram.')
      applyDefaultLayout()
      return
    }

    debug.layout('applySnapshot: Found snapshot, applying...')
    applySnapshotViewport(snapshot)
    applySnapshotNodes(snapshot)
    applySnapshotEdges(snapshot)
    finalizeSnapshot()
  }, [
    canApplySnapshot, selectedEntity, rfInstance, diagram,
    loadSnapshotIfNeeded, applyDefaultLayout, applySnapshotViewport,
    applySnapshotNodes, applySnapshotEdges, finalizeSnapshot, setBaselineViewport
  ])

  // Helper functions for entity switching
  const cacheCurrentLayout = useCallback(() => {
    const prevId = prevSelectedIdRef.current
    if (!prevId || nodes.length === 0) return

    const viewport = rfInstance?.getViewport()
    const snapshot = {
      canvas: viewport ? { scale: viewport.zoom, pan: { x: viewport.x, y: viewport.y } } : undefined,
      nodes: nodes.map((n) => {
        const model = getCanonicalNodeModel(n, diagram)
        return {
          id: n.id,
          position: n.position,
          expansion: { expanded: !!model?.expanded, sections: model?.sections || {} },
          extra: { rawView: !!model?.rawView },
        }
      }),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        data: e.data,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle
      }))
    }
    debug.layout('Cached local layout for', prevId, snapshot)
  }, [nodes, edges, rfInstance, diagram])

  const resetForNewEntity = useCallback(() => {
    debug.diagram('Selected file changed, resetting state.')
    initialEdgesAppliedRef.current = false
    resetViewport()
  }, [resetViewport])

  const updatePrevEntityState = useCallback(() => {
    // Global state is now managed via getOrCreateDiagram, so previous entity states
    // will be updated when they're selected again. No manual state updates needed here.
    debug.diagram('Entity switched - global state will apply to new entity')
  }, [])

  // Entity switching effect
  useEffect(() => {
    currentEntityIdRef.current = selectedEntity?.id || null

    cacheCurrentLayout()
    resetForNewEntity()
    updatePrevEntityState()

    prevSelectedIdRef.current = selectedEntity?.id || null
  }, [selectedEntity, cacheCurrentLayout, resetForNewEntity, updatePrevEntityState])

  // When RF instance is ready or entity changes, load snapshot
  useEffect(() => {
    debug.layout('RF instance ready or entity changed, loading snapshot.', rfInstance, selectedEntity)
    if (rfInstance && selectedEntity) {
      applySnapshot()
    }
  }, [rfInstance, selectedEntity, applySnapshot])

  // React Flow init:
  // - Captures RF instance
  // - Initializes viewport baseline so subsequent changes can be tracked/restored
  const onInit = useCallback((instance: ReactFlowInstance) => {
    debug.diagram('ReactFlow onInit - setting up instance')
    setRfInstance(instance)
    onDirtyChange?.(false)
    const viewport = instance.getViewport()
    initializeViewport(viewport)
  }, [onDirtyChange, initializeViewport])

  // Maximized overlay is handled by SchemaNodeView; we only track id to disable interactions

  return (
    <div className="h-full w-full relative" ref={overlayContainerRef}>
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => setToast(null)}
        />
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onInit={onInit}
        onMove={(_event: any, viewport: Viewport) => handleViewportChange(viewport)}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView={true}
        fitViewOptions={{
          padding: AppConfig.get().schema.fit_view.padding,
          includeHiddenNodes: false,
          minZoom: AppConfig.get().schema.fit_view.min_zoom, // For fitView function calls
          maxZoom: AppConfig.get().schema.fit_view.max_zoom,   // For fitView function calls
        }}
        minZoom={AppConfig.get().schema.fit_view.min_zoom}  // Controls user zoom out limit
        maxZoom={AppConfig.get().schema.fit_view.max_zoom}    // Controls user zoom in limit
        attributionPosition="bottom-left"
        panOnScroll={false}
        selectionOnDrag={false}
        panOnDrag={!isMaximized}
        zoomOnScroll={!isMaximized}
        zoomOnPinch={!isMaximized}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesDraggable={!isMaximized}
        nodesConnectable={false}
        connectOnClick={false}
        elementsSelectable={!isMaximized}
        onPaneContextMenu={(e) => e.preventDefault()}
      >
        <Controls
          showZoom={!isMaximized}
          showFitView={!isMaximized}
          showInteractive={false}
          position="top-left"
        />
        {nodesAreReady && (
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        )}
      </ReactFlow>
    </div>
  )
})
