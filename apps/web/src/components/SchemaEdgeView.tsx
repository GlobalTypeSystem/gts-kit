import React, { Component } from 'react'
import {
  EdgeProps,
  getSmoothStepPath,
  EdgeLabelRenderer,
  Node,
  Position,
} from 'reactflow'
import type { SchemaEdgeModel } from './SchemaEdgeModel'
import { AppConfig } from '@/lib/config'

interface EdgeViewData {
  model: SchemaEdgeModel
  labelPosition?: number
  labelOffset?: { x: number; y: number }
  // Back-compat fields used by persistence until EdgeModel is extended
  sourceHandle?: string
  targetHandle?: string
  label?: string
}

interface InjectedReactFlowApi {
  getNodes: () => Node[]
  setEdges: (updater: any) => void
  getViewport: () => { x: number; y: number; zoom: number }
}

interface EdgeViewCallbacks {
  onEdgeChange?: () => void
}

type EdgeViewProps = EdgeProps<EdgeViewData> & { reactFlowApi: InjectedReactFlowApi } & EdgeViewCallbacks

type DragKind = 'source' | 'target' | 'label' | null

interface EdgeViewState {
  isDragging: DragKind
  tempHandle: string | null
  mouseFlowPosition: { x: number; y: number }
  labelPosition: number
  labelOffset: { x: number; y: number }
}

// 12 sticky positions per card
const STICKY_POSITIONS = {
  top: ['top-1', 'top-2', 'top-3'],
  right: ['right-1', 'right-2', 'right-3'],
  bottom: ['bottom-1', 'bottom-2', 'bottom-3'],
  left: ['left-1', 'left-2', 'left-3'],
}

// Calculate absolute coordinates for a given handle id on a node
const getHandlePosition = (nodeId: string, handleId: string, nodes: Node[]) => {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return { x: 0, y: 0 }

  const { position } = node
  if (!position || isNaN(position.x) || isNaN(position.y)) {
    return { x: 0, y: 0 }
  }

  const cfg = AppConfig.get()
  const width = node.width || cfg.schema.node.width
  const height = node.height || cfg.schema.node.height
  const [side, index] = handleId.split('-')
  const idx = parseInt(index) - 1

  if (isNaN(idx)) return { x: position.x, y: position.y }

  switch (side) {
    case 'top':
      return { x: position.x + (width * (idx + 1)) / 4, y: position.y }
    case 'right':
      return { x: position.x + width, y: position.y + (height * (idx + 1)) / 4 }
    case 'bottom':
      return { x: position.x + (width * (idx + 1)) / 4, y: position.y + height }
    case 'left':
      return { x: position.x, y: position.y + (height * (idx + 1)) / 4 }
    default:
      return { x: position.x + width / 2, y: position.y + height / 2 }
  }
}

export class SchemaEdgeView extends Component<EdgeViewProps, EdgeViewState> {
  private get nodes() { return this.props.reactFlowApi.getNodes() }
  private get viewport() { return this.props.reactFlowApi.getViewport() }
  private setEdges = this.props.reactFlowApi.setEdges
  private onEdgeChange = this.props.onEdgeChange

  state: EdgeViewState = {
    isDragging: null,
    tempHandle: null,
    mouseFlowPosition: { x: 0, y: 0 },
    labelPosition: this.props.data?.model?.labelPosition ?? this.props.data?.labelPosition ?? 0.5,
    labelOffset: this.props.data?.model?.labelOffset ?? this.props.data?.labelOffset ?? { x: 0, y: 0 },
  }

  componentDidMount(): void {
    if (this.state.isDragging) {
      document.addEventListener('mousemove', this.handleMouseMove)
      document.addEventListener('mouseup', this.handleMouseUp)
    }
  }

  componentDidUpdate(prevProps: EdgeViewProps, prevState: EdgeViewState): void {
    if (!prevState.isDragging && this.state.isDragging) {
      document.addEventListener('mousemove', this.handleMouseMove)
      document.addEventListener('mouseup', this.handleMouseUp)
    } else if (prevState.isDragging && !this.state.isDragging) {
      document.removeEventListener('mousemove', this.handleMouseMove)
      document.removeEventListener('mouseup', this.handleMouseUp)
    }

    // Sync label position from model when it changes (e.g., after loading from storage)
    const prevModel = prevProps.data?.model
    const currentModel = this.props.data?.model

    // Also check if data props changed (for initial load or data updates)
    const prevDataLabelPos = prevProps.data?.labelPosition
    const currentDataLabelPos = this.props.data?.labelPosition
    const prevDataLabelOffset = prevProps.data?.labelOffset
    const currentDataLabelOffset = this.props.data?.labelOffset

    if (currentModel && prevModel !== currentModel) {
      const newLabelPosition = currentModel.labelPosition ?? 0.5
      const newLabelOffset = currentModel.labelOffset ?? { x: 0, y: 0 }

      if (newLabelPosition !== this.state.labelPosition ||
          newLabelOffset.x !== this.state.labelOffset.x ||
          newLabelOffset.y !== this.state.labelOffset.y) {
        this.setState({
          labelPosition: newLabelPosition,
          labelOffset: newLabelOffset
        })
      }
    }

    // Also sync from data props if they changed
    if (currentDataLabelPos !== undefined && currentDataLabelPos !== prevDataLabelPos) {
      if (currentDataLabelPos !== this.state.labelPosition) {
        this.setState({ labelPosition: currentDataLabelPos })
      }
    }
    if (currentDataLabelOffset && currentDataLabelOffset !== prevDataLabelOffset) {
      if (currentDataLabelOffset.x !== this.state.labelOffset.x ||
          currentDataLabelOffset.y !== this.state.labelOffset.y) {
        this.setState({ labelOffset: currentDataLabelOffset })
      }
    }
  }

  componentWillUnmount(): void {
    document.removeEventListener('mousemove', this.handleMouseMove)
    document.removeEventListener('mouseup', this.handleMouseUp)
  }

  private validateCoordinate = (value: number, fallback: number = 0) => (isNaN(value) || !isFinite(value) ? fallback : value)

  private findPositionAndOffset = (clientX: number, clientY: number, pathSourceX: number, pathSourceY: number, pathTargetX: number, pathTargetY: number) => {
    const viewport = this.viewport
    const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect()
    if (!reactFlowBounds) return { position: 0.5, offset: { x: 0, y: 0 } }
    const flowX = (clientX - reactFlowBounds.left - viewport.x) / viewport.zoom
    const flowY = (clientY - reactFlowBounds.top - viewport.y) / viewport.zoom
    const dx = pathTargetX - pathSourceX
    const dy = pathTargetY - pathSourceY
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length === 0 || !isFinite(length)) return { position: 0.5, offset: { x: 0, y: 0 } }
    const t = Math.max(0, Math.min(1, ((flowX - pathSourceX) * dx + (flowY - pathSourceY) * dy) / (length * length)))
    const linePointX = pathSourceX + dx * t
    const linePointY = pathSourceY + dy * t
    const offsetX = flowX - linePointX
    const offsetY = flowY - linePointY
    return { position: this.validateCoordinate(t, 0.5), offset: { x: this.validateCoordinate(offsetX, 0), y: this.validateCoordinate(offsetY, 0) } }
  }

  private findClosestStickyPosition = (nodeId: string, clientX: number, clientY: number) => {
    const node = this.nodes.find((n) => n.id === nodeId)
    if (!node) return 'right-2'
    const viewport = this.viewport
    const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect()
    if (!reactFlowBounds) return 'right-2'
    const flowX = (clientX - reactFlowBounds.left - viewport.x) / viewport.zoom
    const flowY = (clientY - reactFlowBounds.top - viewport.y) / viewport.zoom
    let closestHandle = 'right-2'
    let minDistance = Infinity
    Object.entries(STICKY_POSITIONS).forEach(([, handles]) => {
      handles.forEach((handle) => {
        const pos = getHandlePosition(nodeId, handle, this.nodes)
        const distance = Math.sqrt((pos.x - flowX) ** 2 + (pos.y - flowY) ** 2)
        if (distance < minDistance) {
          minDistance = distance
          closestHandle = handle
        }
      })
    })
    return closestHandle
  }

  // Render all possible handle positions for a node as visual annotations
  private renderHandleAnnotations = (nodeId: string, currentHandle?: string) => {
    const node = this.nodes.find((n) => n.id === nodeId)
    if (!node) return null

    const annotations: JSX.Element[] = []

    Object.entries(STICKY_POSITIONS).forEach(([, handles]) => {
      handles.forEach((handle) => {
        const pos = getHandlePosition(nodeId, handle, this.nodes)
        const isCurrentHandle = handle === currentHandle
        const isClosestHandle = handle === this.state.tempHandle

        annotations.push(
          <circle
            key={`${nodeId}-${handle}`}
            cx={this.validateCoordinate(pos.x, 0)}
            cy={this.validateCoordinate(pos.y, 0)}
            r={isClosestHandle ? 8 : 6}
            fill={isClosestHandle ? '#f59e0b' : isCurrentHandle ? '#8b5cf6' : '#10b981'}
            stroke="#fff"
            strokeWidth={isClosestHandle ? 3 : 2}
            opacity={isCurrentHandle ? 0.9 : 0.7}
            style={{ pointerEvents: 'none' }}
          />
        )
      })
    })

    return annotations
  }

  private handleMouseDown = (event: React.MouseEvent, type: Exclude<DragKind, null>) => {
    event.stopPropagation()

    // Initialize mouse position to current handle position to prevent jumping to zero coordinates
    const { source, target } = this.props
    const nodes = this.nodes
    const { data } = this.props
    const model = data?.model

    let initialPosition = { x: 0, y: 0 }

    if (type === 'source') {
      const sourceHandle = data?.sourceHandle || model?.sourceHandle || 'right-2'
      initialPosition = getHandlePosition(source, sourceHandle, nodes)
    } else if (type === 'target') {
      const targetHandle = data?.targetHandle || model?.targetHandle || 'left-2'
      initialPosition = getHandlePosition(target, targetHandle, nodes)
    }

    this.setState({
      isDragging: type,
      mouseFlowPosition: initialPosition
    })
  }

  private handleMouseMove = (event: MouseEvent) => {
    const { source, target } = this.props
    const { isDragging } = this.state
    if (!isDragging) return
    if (isDragging === 'label') {
      const { pathSourceX, pathSourceY, pathTargetX, pathTargetY } = this.computePathEndpoints()
      const { position, offset } = this.findPositionAndOffset(event.clientX, event.clientY, pathSourceX, pathSourceY, pathTargetX, pathTargetY)
      this.setState({ labelPosition: position, labelOffset: offset })
    } else {
      const viewport = this.viewport
      const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect()
      if (reactFlowBounds) {
        const flowX = (event.clientX - reactFlowBounds.left - viewport.x) / viewport.zoom
        const flowY = (event.clientY - reactFlowBounds.top - viewport.y) / viewport.zoom
        this.setState({ mouseFlowPosition: { x: flowX, y: flowY } })
      }
      const nodeId = isDragging === 'source' ? source : target
      const newHandle = this.findClosestStickyPosition(nodeId, event.clientX, event.clientY)
      this.setState({ tempHandle: newHandle })
    }
    event.preventDefault()
    event.stopPropagation()
  }

  private handleMouseUp = (event: MouseEvent) => {
    const { id } = this.props
    const { isDragging, tempHandle, labelPosition, labelOffset } = this.state
    if (!isDragging) return
    if (isDragging === 'label') {
      this.setEdges((edges: any[]) => edges.map((edge) => {
        if (edge.id !== id) return edge
        const newData = { ...edge.data, labelPosition, labelOffset }
        // Update the persisted/backing model if present
        const model = newData.model || edge.data?.model
        if (model) {
          model.updateLabelPosition(labelPosition, labelOffset)
        }
        return { ...edge, data: newData }
      }))
      // Notify diagram that edge has changed (for dirty state tracking)
      this.onEdgeChange?.()
    } else if (tempHandle) {
      const newHandle = tempHandle
      this.setEdges((edges: any[]) =>
        edges.map((edge) => {
          if (edge.id !== id) return edge
          const newData = { ...(edge.data || {}) }
          // Update the persisted/backing model if present under data.model
          const model = newData.model || edge.data?.model
          if (isDragging === 'source') {
            newData.sourceHandle = newHandle
            if (model) {
              model.updateHandles(newHandle, undefined)
            }
          } else {
            newData.targetHandle = newHandle
            if (model) {
              model.updateHandles(undefined, newHandle)
            }
          }
          return {
            ...edge,
            data: newData,
            sourceHandle: isDragging === 'source' ? newHandle : edge.sourceHandle,
            targetHandle: isDragging === 'target' ? newHandle : edge.targetHandle,
          }
        })
      )
      // Notify diagram that edge has changed (for dirty state tracking)
      this.onEdgeChange?.()
    }
    this.setState({ isDragging: null, tempHandle: null })
    event.preventDefault()
    event.stopPropagation()
  }

  private computePathEndpoints() {
    const { source, target, data } = this.props
    const { isDragging, tempHandle, mouseFlowPosition } = this.state
    const nodes = this.nodes
    const model = data?.model
    const sourceHandle = (isDragging === 'source' && tempHandle) || data?.sourceHandle || model?.sourceHandle || 'right-2'
    const targetHandle = (isDragging === 'target' && tempHandle) || data?.targetHandle || model?.targetHandle || 'left-2'
    const sourcePos = getHandlePosition(source, sourceHandle, nodes)
    const targetPos = getHandlePosition(target, targetHandle, nodes)
    let actualSourceX = this.validateCoordinate(sourcePos.x, 0)
    let actualSourceY = this.validateCoordinate(sourcePos.y, 0)
    let actualTargetX = this.validateCoordinate(targetPos.x, 100)
    let actualTargetY = this.validateCoordinate(targetPos.y, 100)
    if (isDragging === 'source') {
      actualSourceX = this.validateCoordinate(mouseFlowPosition.x, actualSourceX)
      actualSourceY = this.validateCoordinate(mouseFlowPosition.y, actualSourceY)
    } else if (isDragging === 'target') {
      actualTargetX = this.validateCoordinate(mouseFlowPosition.x, actualTargetX)
      actualTargetY = this.validateCoordinate(mouseFlowPosition.y, actualTargetY)
    }
    const pathSourceX = this.validateCoordinate(actualSourceX, 0)
    const pathSourceY = this.validateCoordinate(actualSourceY, 0)
    const pathTargetX = this.validateCoordinate(actualTargetX, 100)
    const pathTargetY = this.validateCoordinate(actualTargetY, 100)
    return { sourceHandle, targetHandle, pathSourceX, pathSourceY, pathTargetX, pathTargetY }
  }

  render() {
    const { id, sourcePosition, targetPosition, markerEnd, style, data } = this.props
    const { isDragging, labelPosition, labelOffset } = this.state
    const nodes = this.nodes
    const { source, target } = this.props

    const sourceNode = nodes.find((n) => n.id === source)
    const targetNode = nodes.find((n) => n.id === target)
    if (!sourceNode || !targetNode || !sourceNode.position || !targetNode.position || !isFinite(sourceNode.position.x) || !isFinite(sourceNode.position.y) || !isFinite(targetNode.position.x) || !isFinite(targetNode.position.y)) {
      return null
    }

    const { sourceHandle, targetHandle, pathSourceX, pathSourceY, pathTargetX, pathTargetY } = this.computePathEndpoints()

    // Determine perpendicular anchor positions from current handle ids
    const sideFromHandle = (handleId?: string | null): 'top' | 'right' | 'bottom' | 'left' | undefined => {
      if (!handleId) return undefined
      const side = handleId.split('-')[0]
      if (side === 'top' || side === 'right' || side === 'bottom' || side === 'left') return side
      return undefined
    }
    const positionFromSide = (side: 'top' | 'right' | 'bottom' | 'left' | undefined, fallback: Position): Position => {
      switch (side) {
        case 'top': return Position.Top
        case 'right': return Position.Right
        case 'bottom': return Position.Bottom
        case 'left': return Position.Left
        default: return fallback
      }
    }
    const dynamicSourcePosition = positionFromSide(sideFromHandle(sourceHandle), sourcePosition)
    const dynamicTargetPosition = positionFromSide(sideFromHandle(targetHandle), targetPosition)

    const [edgePath] = getSmoothStepPath({
      sourceX: pathSourceX,
      sourceY: pathSourceY,
      sourcePosition: dynamicSourcePosition,
      targetX: pathTargetX,
      targetY: pathTargetY,
      targetPosition: dynamicTargetPosition,
    })
    if (!edgePath || edgePath.includes('NaN') || edgePath.includes('Infinity')) return null

    const finalSourcePos = getHandlePosition(source, sourceHandle, nodes)
    const finalTargetPos = getHandlePosition(target, targetHandle, nodes)
    const [previewPath] = getSmoothStepPath({
      sourceX: this.validateCoordinate(finalSourcePos.x, pathSourceX),
      sourceY: this.validateCoordinate(finalSourcePos.y, pathSourceY),
      sourcePosition: dynamicSourcePosition,
      targetX: this.validateCoordinate(finalTargetPos.x, pathTargetX),
      targetY: this.validateCoordinate(finalTargetPos.y, pathTargetY),
      targetPosition: dynamicTargetPosition,
    })
    const safePreviewPath = !previewPath || previewPath.includes('NaN') || previewPath.includes('Infinity') ? 'M0,0 L100,100' : previewPath

    const getPositionAlongPath = (t: number, offset = { x: 0, y: 0 }) => {
      const safeT = this.validateCoordinate(t, 0.5)
      const safeOffsetX = this.validateCoordinate(offset.x, 0)
      const safeOffsetY = this.validateCoordinate(offset.y, 0)
      const x = pathSourceX + (pathTargetX - pathSourceX) * safeT + safeOffsetX
      const y = pathSourceY + (pathTargetY - pathSourceY) * safeT + safeOffsetY
      return { x: this.validateCoordinate(x, (pathSourceX + pathTargetX) / 2), y: this.validateCoordinate(y, (pathSourceY + pathTargetY) / 2) }
    }

    let labelText = data?.label ?? data?.model?.name ?? ''
    labelText = labelText.split('.').join('.\n')

    return (
      <>
        <path
          id={id}
          style={{
            stroke: isDragging ? '#f59e0b' : style?.stroke || '#8b5cf6',
            strokeWidth: isDragging ? 3 : style?.strokeWidth || 2,
            strokeDasharray: style?.strokeDasharray,
            opacity: isDragging ? 0.7 : 1,
          }}
          className="react-flow__edge-path"
          d={edgePath}
          markerEnd={markerEnd}
        />

        {isDragging && (
          <path
            style={{
              stroke: style?.stroke || '#8b5cf6',
              strokeWidth: style?.strokeWidth || 2,
              strokeDasharray: style?.strokeDasharray || '5,5',
              opacity: 0.8,
            }}
            className="react-flow__edge-path"
            d={safePreviewPath}
          />
        )}

        {/* Large hit areas for grabbing endpoints */}
        <circle
          cx={this.validateCoordinate(pathSourceX, 0)}
          cy={this.validateCoordinate(pathSourceY, 0)}
          r={15}
          fill="transparent"
          stroke="transparent"
          className="cursor-grab hover:cursor-grabbing"
          style={{ pointerEvents: 'all' }}
          onMouseDown={(e) => this.handleMouseDown(e, 'source')}
        />
        <circle
          cx={this.validateCoordinate(pathTargetX, 100)}
          cy={this.validateCoordinate(pathTargetY, 100)}
          r={15}
          fill="transparent"
          stroke="transparent"
          className="cursor-grab hover:cursor-grabbing"
          style={{ pointerEvents: 'all' }}
          onMouseDown={(e) => this.handleMouseDown(e, 'target')}
        />

        {isDragging && (
          <>
            <circle
              cx={this.state.isDragging === 'source' ? this.validateCoordinate(this.state.mouseFlowPosition.x, pathSourceX) : this.validateCoordinate(pathSourceX, 0)}
              cy={this.state.isDragging === 'source' ? this.validateCoordinate(this.state.mouseFlowPosition.y, pathSourceY) : this.validateCoordinate(pathSourceY, 0)}
              r={this.state.isDragging === 'source' ? 10 : 8}
              fill={this.state.isDragging === 'source' ? '#f59e0b' : '#8b5cf6'}
              stroke="#fff"
              strokeWidth={this.state.isDragging === 'source' ? 4 : 3}
              style={{ pointerEvents: 'none' }}
            />
            <circle
              cx={this.state.isDragging === 'target' ? this.validateCoordinate(this.state.mouseFlowPosition.x, pathTargetX) : this.validateCoordinate(pathTargetX, 100)}
              cy={this.state.isDragging === 'target' ? this.validateCoordinate(this.state.mouseFlowPosition.y, pathTargetY) : this.validateCoordinate(pathTargetY, 100)}
              r={this.state.isDragging === 'target' ? 10 : 8}
              fill={this.state.isDragging === 'target' ? '#f59e0b' : '#8b5cf6'}
              stroke="#fff"
              strokeWidth={this.state.isDragging === 'target' ? 4 : 3}
              style={{ pointerEvents: 'none' }}
            />
          </>
        )}

        {isDragging && (
          <>
            <circle
              cx={this.validateCoordinate(getHandlePosition(source, sourceHandle, nodes).x, pathSourceX)}
              cy={this.validateCoordinate(getHandlePosition(source, sourceHandle, nodes).y, pathSourceY)}
              r={6}
              fill="#8b5cf6"
              stroke="#fff"
              strokeWidth={2}
              opacity={0.6}
              style={{ pointerEvents: 'none' }}
            />
            <circle
              cx={this.validateCoordinate(getHandlePosition(target, targetHandle, nodes).x, pathTargetX)}
              cy={this.validateCoordinate(getHandlePosition(target, targetHandle, nodes).y, pathTargetY)}
              r={6}
              fill="#8b5cf6"
              stroke="#fff"
              strokeWidth={2}
              opacity={0.6}
              style={{ pointerEvents: 'none' }}
            />
          </>
        )}

        {/* Show handle annotations for the target node when dragging source, or source node when dragging target */}
        {isDragging && isDragging !== 'label' && (
          <>
            {isDragging === 'target' && this.renderHandleAnnotations(target, targetHandle)}
            {isDragging === 'source' && this.renderHandleAnnotations(source, sourceHandle)}
          </>
        )}

        {labelText && (() => {
          const pos = getPositionAlongPath(labelPosition, labelOffset)
          const validLabelX = this.validateCoordinate(pos.x, (pathSourceX + pathTargetX) / 2)
          const validLabelY = this.validateCoordinate(pos.y, (pathSourceY + pathTargetY) / 2)
          return (
            <EdgeLabelRenderer>
              <div
                style={{
                  position: 'absolute',
                  transform: `translate(-50%, -50%) translate(${validLabelX}px,${validLabelY}px)`,
                  fontSize: 12,
                  pointerEvents: 'all',
                  cursor: isDragging === 'label' ? 'grabbing' : 'grab',
                  backgroundColor: isDragging === 'label' ? '#f59e0b' : 'white',
                  color: isDragging === 'label' ? 'white' : 'black',
                  whiteSpace: 'pre-line',
                }}
                className="px-2 py-1 rounded shadow border text-xs select-none"
                onMouseDown={(e) => this.handleMouseDown(e, 'label')}
              >
                {labelText}
              </div>
            </EdgeLabelRenderer>
          )
        })()}
      </>
    )
  }
}

// Wrapper to inject React Flow API via hook into the class component
import { useReactFlow } from 'reactflow'
export default function EdgeViewWrapper(props: EdgeProps<EdgeViewData> & EdgeViewCallbacks) {
  const api = useReactFlow()
  return <SchemaEdgeView {...props as any} reactFlowApi={api as any} />
}
