import dagre from '@dagrejs/dagre'
import { AppConfig } from '@/lib/config'
import { debug } from '@/lib/debug'
import type { Viewport } from '@/lib/types'
import { getEdgePriority, getEdgeStyle } from '@/lib/edgeConfig'
import { SchemaNodeModel, type NodeKind } from './SchemaNodeModel'
import { SchemaEdgeModel, type EdgeKind } from './SchemaEdgeModel'
import type { JsonObj, JsonSchema } from '@gts/shared'
import type { Edge as RFEdge, Node as RFNode } from 'reactflow'
import type { GlobalViewState } from '@/lib/diagramRegistry'

export class DiagramModel {
  private root: JsonObj | JsonSchema
  private jsonSchemas: JsonSchema[]
  private jsonObjs: JsonObj[]
  private snapshotChecked: boolean
  private globalViewState: GlobalViewState

  // Layout view parameters
  private viewport: Viewport
  private origViewport: Viewport

  // Public arrays consumed by React Flow
  edges: RFEdge<any>[] = []
  nodes: RFNode<any>[] = []

  private nodeMap = new Map<string, SchemaNodeModel>()
  // Internal edge models used during graph computation
  private edgeModels: SchemaEdgeModel[] = []
  private edgeMap = new Map<string, SchemaEdgeModel>()

  constructor(
    root: JsonObj | JsonSchema,
    jsonSchemas: JsonSchema[],
    jsonObjs: JsonObj[],
    globalViewState: GlobalViewState
  ) {
    this.root = root
    this.jsonSchemas = jsonSchemas
    this.jsonObjs = jsonObjs
    this.globalViewState = globalViewState
    this.snapshotChecked = false

    debug.diagram('constructor', root.id)
    this.viewport = { x: 0, y: 0, zoom: 1 }
    this.origViewport = { ...this.viewport }

    this.edgeModels = []
    this.nodes = []
    this.edges = []
    this.build()
  }

  initViewport(viewport: Viewport) {
    this.viewport = {...viewport}
    this.origViewport = {...viewport}
    debug.viewport(this.root.id, 'initViewport', viewport)
  }

  updateViewport(viewport: Viewport) {
    this.viewport = {...viewport}
    debug.viewport(this.root.id, 'updateViewport', viewport)
  }

  getViewport(): Viewport {
    debug.viewport(this.root.id, 'getViewport', this.viewport)
    return { ...this.viewport }
  }

  // Get node model by ID from nodeMap
  getNodeModel(id: string): SchemaNodeModel | undefined {
    return this.nodeMap.get(id)
  }

  // Get edge model by ID (similar to nodeMap access)
  getEdgeModel(id: string): SchemaEdgeModel | undefined {
    return this.edgeMap.get(id)
  }

  refresh() {
    this.refreshNodes()
    this.refreshEdges()
  }

  // Refresh the nodes array with current state from nodeMap (positions, rawView, expansion, sections)
  private refreshNodes() {
    debug.diagram('Refreshing nodes with current state from nodeMap')
    this.nodes = this.nodes.map((rfNode) => {
      const nodeModel = this.nodeMap.get(rfNode.id)
      if (nodeModel) {
        debug.diagram(`refreshNodes: Updating node ${rfNode.id} position from (${rfNode.position.x}, ${rfNode.position.y}) to (${nodeModel.position.x}, ${nodeModel.position.y}), rawView: ${nodeModel.rawView}, expanded: ${nodeModel.expanded}`)
        return {
          ...rfNode,
          position: { x: nodeModel.position.x, y: nodeModel.position.y },
          data: {
            ...rfNode.data,
            model: nodeModel, // Always use the canonical model instance from nodeMap
            rootNodeId: this.root.id // Keep this as it's view-specific metadata
          }
        }
      }
      return rfNode
    })
  }

  // Refresh the edges array with current state from edgeMap (handlers)
  private refreshEdges() {
    debug.diagram('Refreshing edges with current state from edgeMap')
    this.edges = this.edges.map((rfEdge) => {
      const edgeModel = this.edgeMap.get(rfEdge.id)
      if (edgeModel) {
        debug.diagram(`Updating edge ${rfEdge.id} handles from (${rfEdge.sourceHandle}, ${rfEdge.targetHandle}) to (${edgeModel.sourceHandle}, ${edgeModel.targetHandle})`)
        return {
          ...rfEdge,
          sourceHandle: edgeModel.sourceHandle,
          targetHandle: edgeModel.targetHandle,
          data: {
            ...rfEdge.data,
            model: edgeModel, // Only store model reference - all metadata should come from model
          }
        }
      }
      return rfEdge
    })
  }

  private findEntity(id: string): { kind: NodeKind; value: JsonObj | JsonSchema } | null {
    // Direct id match first
    const s = this.jsonSchemas.find(x => x.id === id)
    if (s) return { kind: 'schema', value: s }
    const j = this.jsonObjs.find(x => x.id === id)
    if (j) return { kind: 'json', value: j }
    return null
  }

  private ensureNode(id: string): SchemaNodeModel | null {
    if (this.nodeMap.has(id)) return this.nodeMap.get(id)!
    const ent = this.findEntity(id)
    if (!ent) return null

    // Determine if this is the root node
    const isRootNode = ent.value.id === this.root.id

    // For root nodes, apply global preferences; for non-root nodes, use defaults
    const shouldMaximize = isRootNode ? this.globalViewState.hasAnyMaximizedEntity : false
    const shouldUseRawView = isRootNode ? this.globalViewState.globalRawViewPreference : false

    debug.diagram(`Creating node ${id} (root: ${isRootNode}) with expanded: ${shouldMaximize}, rawView: ${shouldUseRawView}`)

    // Create a unique node instance for this diagram
    const n = new SchemaNodeModel({
      entity: ent.value,
      position: { x: 0, y: 0 },
      expanded: true,
      sections: {},
      isMaximized: shouldMaximize,
      rawView: shouldUseRawView,
    })
    this.nodeMap.set(id, n)
    debug.diagram(`Created unique node instance for ${id} in diagram ${this.root.id}`)
    return n
  }

  setSnapshotChecked(v: boolean) {
    this.snapshotChecked = v
  }

  getSnapshotChecked() {
    return this.snapshotChecked
  }

  // Get the root node's current rawView state
  getRootNodeRawView(): boolean {
    const rootNodeModel = this.nodeMap.get(this.root.id)
    return rootNodeModel?.rawView ?? false
  }

  isDirty(): boolean {
//    console.log('[Debug] isDirty - diagram ', this.viewport.x, this.origViewport.x, this.viewport.y, this.origViewport.y, this.viewport.zoom, this.origViewport.zoom)
    if (Math.abs(this.viewport.x - this.origViewport.x) > 1
        || Math.abs(this.viewport.y - this.origViewport.y) > 1
        || Math.abs(this.viewport.zoom - this.origViewport.zoom) > 0.01)
      return true
    for (const n of this.nodeMap.values()) {
//      console.log('[Debug] isDirty - node', n.id, n.isDirty())
      if (n.isDirty()) return true
    }
    // Check edge dirty state
    for (const e of this.edgeMap.values()) {
//      console.log('[Debug] isDirty - edge', e.id, e.isDirty())
      if (e.isDirty()) return true
    }
    debug.diagram('IS DIRTY == FALSE')
    return false
  }

  // Reset dirty baselines after successful save
  resetDirtyBaseline() {
    this.origViewport = { ...this.viewport }
    for (const n of this.nodeMap.values()) {
      n.resetDirtyBaseline()
    }
    for (const e of this.edgeMap.values()) {
      e.resetDirtyBaseline()
    }
    debug.diagram(`Reset dirty baselines for diagram ${this.root.id}`)
  }

  // Build node payload for saving layout
  buildNodePayload() {
    return Array.from(this.nodeMap.values()).map((model) => model.serialize())
  }

  // Build edge payload for saving layout
  buildEdgePayload() {
    return Array.from(this.edgeMap.values()).map((model) => model.serialize())
  }

  private relationshipPriority(relationship: EdgeKind): number {
    return getEdgePriority(relationship)
  }

  private styleFor(relationship: EdgeKind) {
    return getEdgeStyle(relationship)
  }

  private addEdge(source: SchemaNodeModel, target: SchemaNodeModel, relationship: EdgeKind, name: string) {
    // Exclude self-self edges
    if (source.id === target.id) return
    const id = `${source.id}|${target.id}|${relationship}|${name}`
    // Create a unique edge instance for this diagram
    const e = new SchemaEdgeModel({ id, source, target, kind: relationship, name })
    this.edgeModels.push(e)
    this.edgeMap.set(id, e)
    // also attach to source node for quick lookup
    source.addEdge(e)
    debug.diagram(`Created unique edge instance ${id} in diagram ${this.root.id}`)
  }

  private processElement(elementId: string, visited: Set<string>) {
    if (visited.has(elementId)) return
    visited.add(elementId)
    const sourceNode = this.ensureNode(elementId)
    if (!sourceNode) return

    const ent = this.findEntity(elementId)
    if (!ent) return

    if (ent.kind === 'schema') {
      const schema = ent.value as JsonSchema
      const refs = (schema.schemaRefs || []).map((r: any) => ({ id: typeof r === 'string' ? r : r.id, sourcePath: typeof r === 'string' ? '$ref' : r.sourcePath }))
      for (const { id: targetId, sourcePath } of refs) {
        // Skip self references
        if (targetId === elementId) continue
        const targetEnt = this.findEntity(targetId)
        if (!targetEnt) continue
        const targetNode = this.ensureNode(targetId)
        if (!targetNode) continue
        this.processElement(targetId, visited)
        this.addEdge(sourceNode, targetNode, 'ref', sourcePath)
      }
    } else {
      const json = ent.value as JsonObj
      if (json.schemaId) {
        const targetId = json.schemaId
        const targetEnt = this.findEntity(targetId)
        if (targetEnt) {
          const targetNode = this.ensureNode(targetId)
          if (targetNode) {
            this.processElement(targetId, visited)
            this.addEdge(sourceNode, targetNode, 'schema', 'schema')
          }
        }
      }
    }

    // GTS links for both kinds
    const gts = (ent.kind === 'schema' ? (ent.value as JsonSchema).gtsRefs : (ent.value as JsonObj).gtsRefs) || []
    for (const { id: targetId, sourcePath } of gts as any[]) {
      const targetEnt = this.findEntity(targetId)
      if (!targetEnt || targetId === elementId) continue
      const targetNode = this.ensureNode(targetId)
      if (!targetNode) continue
      this.processElement(targetId, visited)
      const rel: EdgeKind = ent.kind === 'schema' ? 'gts' : 'gts-json'
      this.addEdge(sourceNode, targetNode, rel, sourcePath || '')
    }
  }

  private build() {
    const rootId = this.root.id
    const visited = new Set<string>()
    this.processElement(rootId, visited)

    // layout
    const dagreGraph = new dagre.graphlib.Graph()
    dagreGraph.setDefaultEdgeLabel(() => ({}))
    const cfg = AppConfig.get()
    dagreGraph.setGraph({ rankdir: 'LR', nodesep: cfg.schema.node.nodesep, ranksep: cfg.schema.node.ranksep })
    const entries = Array.from(this.nodeMap.values())
    for (const n of entries) {
      dagreGraph.setNode(n.id, { width: cfg.schema.node.width, height: cfg.schema.node.height })
    }
    for (const e of this.edgeModels) {
      dagreGraph.setEdge(e.sourceId, e.targetId)
    }
    dagre.layout(dagreGraph)

    const rfNodes = entries.map((n) => {
      const pos = dagreGraph.node(n.id)
      const position = { x: pos.x - cfg.schema.node.width / 2, y: pos.y - cfg.schema.node.height / 2 }
      // Store the initial dagre position in the node model and set as clean baseline
      n.position = { ...position }
      n.origPosition = { ...position }
      debug.layout(`Set initial position for node ${n.id} in diagram ${this.root.id}: (${position.x}, ${position.y})`)
      return {
        id: n.id,
        type: 'schemaNode',
        data: { model: n },
        position, // React Flow requires this for rendering, but model is the source of truth
      }
    })

    // Deduplicate by source-target with priority and then distribute handles among the actually rendered edges
    const rfEdges: any[] = []

    // Helper to decide which side of node an edge should attach to based on relative position
    const decideSide = (ax: number, ay: number, bx: number, by: number): 'left'|'right'|'top'|'bottom' => {
      const dx = bx - ax
      const dy = by - ay
      if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? 'right' : 'left'
      }
      return dy >= 0 ? 'bottom' : 'top'
    }

    // Build maps of per-node, per-side edge lists for both source and target nodes
    type Side = 'left'|'right'|'top'|'bottom'
    interface EdgeRef { edge: SchemaEdgeModel; otherId: string }
    const sourceSideMap = new Map<string, Record<Side, EdgeRef[]>>()
    const targetSideMap = new Map<string, Record<Side, EdgeRef[]>>()

    const ensureSideBuckets = (m: Map<string, Record<Side, EdgeRef[]>>, nodeId: string) => {
      if (!m.has(nodeId)) {
        m.set(nodeId, { left: [], right: [], top: [], bottom: [] })
      }
      return m.get(nodeId)!
    }

    // Node center helpers (use configured size)
    const centerOf = (n: SchemaNodeModel) => ({ cx: n.position.x + cfg.schema.node.width/2, cy: n.position.y + cfg.schema.node.height/2 })

    // First choose which edges will actually be rendered (highest priority per source-target)
    const chosenByPair = new Map<string, { edge: SchemaEdgeModel; priority: number }>()
    for (const e of this.edgeModels) {
      const pk = `${e.sourceId}|${e.targetId}`
      const pr = this.relationshipPriority(e.kind)
      const existing = chosenByPair.get(pk)
      if (!existing || pr > existing.priority) {
        chosenByPair.set(pk, { edge: e, priority: pr })
      }
    }
    const chosenEdges = Array.from(chosenByPair.values()).map(v => v.edge)

    // Populate side maps only with chosen (rendered) edges
    for (const e of chosenEdges) {
      const s = e.source
      const t = e.target
      const sc = centerOf(s)
      const tc = centerOf(t)
      const sSide = decideSide(sc.cx, sc.cy, tc.cx, tc.cy)
      const tSide = decideSide(tc.cx, tc.cy, sc.cx, sc.cy)
      ensureSideBuckets(sourceSideMap, s.id)[sSide].push({ edge: e, otherId: t.id })
      ensureSideBuckets(targetSideMap, t.id)[tSide].push({ edge: e, otherId: s.id })
    }

    // Distributor: assign handle index array based on count
    const indicesForCount = (count: number): number[] => {
      if (count <= 0) return []
      if (count === 1) return [2]
      if (count === 2) return [1, 3]
      if (count === 3) return [1, 2, 3]
      // 4+ cycle 1,2,3,1,2,3...
      const arr: number[] = []
      for (let i = 0; i < count; i++) arr.push((i % 3) + 1)
      return arr
    }

    // Sort and assign handles for a node's side list
    const assignHandles = (nodeId: string, buckets: Record<Side, EdgeRef[]>, isSource: boolean) => {
      const nodeModel = this.nodeMap.get(nodeId)
      if (!nodeModel) return
      const apply = (side: Side) => {
        const list = buckets[side]
        if (!list || list.length === 0) return
        // Sort list by perpendicular axis so top-most/left-most connects to respective low index
        list.sort((a, b) => {
          const aModel = this.nodeMap.get(a.otherId)!
          const bModel = this.nodeMap.get(b.otherId)!
          const ac = centerOf(aModel)
          const bc = centerOf(bModel)
          if (side === 'left' || side === 'right') return ac.cy - bc.cy // top to bottom
          return ac.cx - bc.cx // left to right
        })
        const indices = indicesForCount(list.length)
        list.forEach((ref, i) => {
          const idx = indices[i] || 2
          const handle = `${side}-${idx}` as const
          if (isSource) {
            ref.edge.sourceHandle = handle
            ref.edge.origSourceHandle = handle
          } else {
            ref.edge.targetHandle = handle
            ref.edge.origTargetHandle = handle
          }
        })
      }
      apply('left'); apply('right'); apply('top'); apply('bottom')
    }

    // Apply distribution to all nodes on the chosen set
    for (const [nodeId, buckets] of sourceSideMap.entries()) assignHandles(nodeId, buckets, true)
    for (const [nodeId, buckets] of targetSideMap.entries()) assignHandles(nodeId, buckets, false)

    // Now build RF edges only from chosen edges with styles and the computed handles
    for (const e of chosenEdges) {
      // Final guard against self edges
      if (e.sourceId === e.targetId) continue
      const style = this.styleFor(e.kind)
      // Fallback if distribution didn't set handles
      if (!e.sourceHandle) { e.sourceHandle = 'right-2'; e.origSourceHandle = 'right-2' }
      if (!e.targetHandle) { e.targetHandle = 'left-2'; e.origTargetHandle = 'left-2' }
      rfEdges.push({
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: 'custom' as const,
        data: { model: e },
        style,
      })
    }

    this.nodes = rfNodes as RFNode<any>[]
    this.edges = rfEdges as RFEdge<any>[]
  }
}
