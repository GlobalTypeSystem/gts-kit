import { Component, createRef } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, type NodeProps } from 'reactflow'
import { ChevronDown, ChevronUp, CheckCircle, AlertCircle, Code2, List, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PropertyViewer } from './PropertyViewer'
import { JsonCode } from '@/components/JsonCode'
import { cn, renderGtsNameWithBreak } from '@/lib/utils'
import { diagramRegistry } from '@/lib/diagramRegistry'
import { Popup, PopupTrigger, PopupContent } from '@/components/ui/popup'
import type { SchemaNodeModel } from './SchemaNodeModel'


export class SchemaNodeView extends Component<NodeProps<any>, {}> {
  private nodeRef = createRef<HTMLDivElement>()
  private model!: SchemaNodeModel

  // Accessors for callbacks from data
  private onMaximize?: (isMaximized: boolean) => void
  private onMaximizeRawJson?: (isRawView: boolean) => void
  private onNodeChange?: () => void

  constructor(props: NodeProps<any>) {
    super(props)
    const d = props.data || {}
    this.model = d.model as SchemaNodeModel
    this.onMaximize = d.onMaximize
    this.onMaximizeRawJson = d.onMaximizeRawJson
    this.onNodeChange = d.onNodeChange
  }

  private ensureModel() {
    const d = this.props.data || {}
    if (d.model && this.model !== d.model) {
      this.model = d.model as SchemaNodeModel
    }
    // Always keep callback references up to date
    this.onMaximize = d.onMaximize
    this.onMaximizeRawJson = d.onMaximizeRawJson
    this.onNodeChange = d.onNodeChange
  }

  componentDidUpdate(prevProps: NodeProps<any>) {
    const prevModel = (prevProps.data || {}).model as SchemaNodeModel
    const curModel = (this.props.data || {}).model as SchemaNodeModel
    // Refresh local references if data object changed
    if (prevModel !== curModel) {
      this.model = curModel
      this.onMaximize = this.props.data?.onMaximize
      this.onMaximizeRawJson = this.props.data?.onMaximizeRawJson
      this.onNodeChange = this.props.data?.onNodeChange
    }

    // Keep model position in sync with React Flow provided coordinates
    const { xPos, yPos } = (this.props as any)
    const nextX = Number.isFinite(xPos) ? xPos : this.model?.position?.x
    const nextY = Number.isFinite(yPos) ? yPos : this.model?.position?.y
    if (this.model && Number.isFinite(nextX) && Number.isFinite(nextY)) {
      this.model.updatePosition({ x: nextX, y: nextY })
    }
    // console.log("SchemaNodeView componentDidUpdate", this.model.entity.id, this.model.position)
  }

  private isSchemaNode() {
    const m = this.model
    if (m) return m.entity.isSchema === true
    return false
  }

  private getIcon() {
    const validation = this.model?.validation
    const isSchema = this.isSchemaNode()

    if (validation && !validation.valid) {
      return <AlertCircle className="h-4 w-4 text-red-100 bg-red-500 rounded-full" />
    }

    return isSchema
      ? <CheckCircle className="h-4 w-4 text-blue-500" />
      : <CheckCircle className="h-4 w-4 text-green-500" />
  }

  private getNodeColor() {
    return this.isSchemaNode() ? 'border-blue-200 bg-blue-100' : 'border-green-200 bg-green-100'
  }

  private getTextColor() {
    return this.isSchemaNode() ? 'text-blue-600' : 'text-green-600'
  }

  private displayLabel() {
    const m = this.model
    if (m) {
      return m.entity.label || ""
    }
    return ""
  }

  private handleMaximize = (isMaximized: boolean) => {
    this.model.isMaximized = isMaximized
    this.onMaximize?.(isMaximized)
    this.onMaximizeRawJson?.(this.model.rawView)
    this.onNodeChange?.()
    this.forceUpdate()
  }

  private handleToggleExpanded = () => {
    const next = !this.model.expanded
    this.model.expanded = next
    // notify diagram (e.g., to mark dirty) without relying on it to toggle
    this.onNodeChange?.()
    // force local re-render since we own presentation state
    this.forceUpdate()
  }

  private handleToggleRawView = () => {
    if (this.model.isMaximized) {
        // handle maximized view differently and do not use the model state
        const next = !diagramRegistry.getViewState().globalRawViewPreference
        this.onMaximizeRawJson?.(next)
    } else {
        // notify diagram (e.g., to mark dirty)
        const next = !this.model.rawView
        this.model.rawView = next
    }
    this.onNodeChange?.()
    this.forceUpdate()
  }

  private findPropertyInJson(code: string, instancePath: string): { lineStart: number; lineEnd: number; charStart: number; charEnd: number } | null {
    // Parse instancePath like "/retention2" or "/nested/property"
    if (!instancePath || instancePath === '/') return null

    const pathParts = instancePath.split('/').filter(p => p)
    if (pathParts.length === 0) return null

    const propertyName = pathParts[pathParts.length - 1]

    // Find all occurrences of the property name in quotes
    const regex = new RegExp(`"${propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')
    const lines = code.split('\n')

    let currentOffset = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = regex.exec(line)

      if (match) {
        // Check if this is a property key (followed by ":")
        const afterMatch = line.substring(match.index + match[0].length).trim()
        if (afterMatch.startsWith(':')) {
          // Found the property key, now find the value
          const colonIndex = match.index + match[0].length + line.substring(match.index + match[0].length).indexOf(':')

          // Find the end of the value (next comma, closing brace, or end of line)
          let valueEnd = colonIndex + 1
          let depth = 0
          let inString = false

          for (let j = i; j < lines.length; j++) {
            const currentLine = j === i ? lines[j].substring(valueEnd) : lines[j]

            for (let k = 0; k < currentLine.length; k++) {
              const char = currentLine[k]

              if (char === '"' && (k === 0 || currentLine[k - 1] !== '\\')) {
                inString = !inString
              } else if (!inString) {
                if (char === '{' || char === '[') depth++
                else if (char === '}' || char === ']') depth--
                else if ((char === ',' || char === '}' || char === ']') && depth === 0) {
                  return {
                    lineStart: i,
                    lineEnd: j,
                    charStart: match.index,
                    charEnd: j === i ? valueEnd + k : currentLine.length
                  }
                }
              }
            }

            if (j > i) valueEnd = 0
          }

          return {
            lineStart: i,
            lineEnd: i,
            charStart: match.index,
            charEnd: line.length
          }
        }
      }
      currentOffset += line.length + 1
    }

    return null
  }

  private renderCodeWithErrors(code: string): JSX.Element {
    const validation = this.model?.validation
    if (!validation || validation.valid || !validation.errors.length) {
      return <JsonCode code={code} />
    }

    // Extract error positions from validation errors
    // First try JSONC parser errors (with offset)
    const errorRegions: Array<{ start: number; end: number; message: string }> = []

    validation.errors.forEach((error) => {
      // Try to extract offset from error message like "at offset 123 (length: 5)"
      const match = error.message.match(/at offset (\d+) \(length: (\d+)\)/)
      if (match) {
        const offset = parseInt(match[1], 10)
        const length = parseInt(match[2], 10)
        errorRegions.push({
          start: offset,
          end: offset + length,
          message: error.message
        })
      }
    })

    // If we have offset-based errors (JSONC parse errors), use character-level highlighting
    if (errorRegions.length > 0) {
      const segments: Array<{ text: string; isError: boolean; message?: string }> = []
      let lastIndex = 0

      errorRegions.sort((a, b) => a.start - b.start).forEach((region) => {
        if (region.start > lastIndex) {
          segments.push({ text: code.substring(lastIndex, region.start), isError: false })
        }
        segments.push({
          text: code.substring(region.start, region.end),
          isError: true,
          message: region.message
        })
        lastIndex = region.end
      })

      if (lastIndex < code.length) {
        segments.push({ text: code.substring(lastIndex), isError: false })
      }

      return (
        <div className="bg-[#011627] rounded-md overflow-auto">
          <pre className="m-0 p-3 text-xs leading-5 font-mono text-gray-200 select-text cursor-text">
            {segments.map((segment, index) =>
              segment.isError ? (
                <span
                  key={index}
                  className="bg-red-500 text-white px-1 rounded cursor-help"
                  title={segment.message}
                >
                  {segment.text}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </pre>
        </div>
      )
    }

    // Otherwise, use line-based highlighting for JSON schema validation errors
    const lines = code.split('\n')
    const errorLines = new Map<number, Array<{ message: string; keyword?: string }>>()

    validation.errors.forEach((error) => {
      let targetPath = error.instancePath

      // Handle additionalProperties errors - extract property name from message
      if (error.keyword === 'additionalProperties' && error.message) {
        const match = error.message.match(/must NOT have additional property ['"]([^'"]+)['"]/)
        if (match) {
          // Build path: if instancePath is '/', use '/propertyName', otherwise append
          targetPath = error.instancePath === '/' ? `/${match[1]}` : `${error.instancePath}/${match[1]}`
        }
      }

      if (targetPath) {
        const location = this.findPropertyInJson(code, targetPath)
        if (location) {
          for (let i = location.lineStart; i <= location.lineEnd; i++) {
            if (!errorLines.has(i)) {
              errorLines.set(i, [])
            }
            errorLines.get(i)!.push({
              message: error.message,
              keyword: error.keyword
            })
          }
        }
      }
    })

    return (
      <div className="bg-[#011627] rounded-md overflow-auto">
        <pre className="m-0 p-3 text-xs leading-5 font-mono text-gray-200 select-text cursor-text">
          {lines.map((line, index) => {
            const errors = errorLines.get(index)
            if (errors && errors.length > 0) {
              const errorMessage = errors.map(e => `${e.message}${e.keyword ? ` (${e.keyword})` : ''}`).join('; ')
              return (
                <div key={index}>
                  <span
                    className="bg-red-500/20 border-l-2 border-red-500 block cursor-help"
                    title={errorMessage}
                  >
                    {line}
                  </span>
                </div>
              )
            }
            return <div key={index}>{line}</div>
          })}
        </pre>
      </div>
    )
  }

  private handleToggleSection = (path: string, open: boolean) => {
    // console.log(`[Debug] handleToggleSection: ${this.model.entity.id} path=${path} open=${open}`)
    // console.log(`[Debug] handleToggleSection: before - sections:`, this.model.sections)
    const next = { ...(this.model.sections || {}) }

    // Determine the default state based on nesting level (same logic as PropertyViewer)
    const level = path.split('/').length - 1 // Count slashes to determine nesting level
    const defaultExpanded = level < 2 // Same as PropertyViewer: level < 2 means default expanded

    // console.log(`[Debug] handleToggleSection: path="${path}" level=${level} defaultExpanded=${defaultExpanded}`)

    if (open === defaultExpanded) {
      // If setting to default state, remove the key entirely
      // console.log(`[Debug] handleToggleSection: Removing key (returning to default)`)
      delete next[path]
    } else {
      // If setting to non-default state, explicitly store the value
      // console.log(`[Debug] handleToggleSection: Setting explicit value=${open}`)
      next[path] = open
    }

    this.model.sections = next
    // console.log(`[Debug] handleToggleSection: after - sections:`, this.model.sections)
    this.onNodeChange?.()
    this.forceUpdate()
  }

  initLayout(position: { x: number; y: number }, expanded: boolean, rawView: boolean, sections: Record<string, boolean>) {
    this.model.initLayout(position, expanded, rawView, sections)
    this.forceUpdate()
  }

  render() {
    this.ensureModel()
    const d = this.props.data || {}
    const isExpanded = this.model ? !!this.model.expanded : true // Default to expanded if no model
    const sectionStates = this.model ? (this.model.sections || {}) : {} // Default to empty sections if no model
    const overlayContainer: HTMLElement | null = (d.overlayContainer?.current as HTMLElement | null) || null
    let rawView = false
    if (this.model && this.model.isMaximized) {
        rawView = diagramRegistry.getViewState().globalRawViewPreference
        console.log('SchemaNodeView.render: rawView = ' + rawView + ' (global)')
    } else {
        rawView = this.model.rawView
        console.log('SchemaNodeView.render: rawView = ' + rawView + ' (node)')
    }

    return (
      <div
        ref={this.nodeRef}
        className={cn('w-[400px]')}
        onWheel={(e) => { e.stopPropagation() }}
        style={{ pointerEvents: 'all' }}
      >
      {/* Target handles */}
      <Handle type="target" position={Position.Left} id="left-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '25%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Left} id="left-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '50%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Left} id="left-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '75%', pointerEvents: 'none' }} />

      <Handle type="target" position={Position.Top} id="top-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '25%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Top} id="top-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '50%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Top} id="top-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '75%', pointerEvents: 'none' }} />

      <Handle type="target" position={Position.Right} id="right-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '25%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Right} id="right-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '50%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Right} id="right-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '75%', pointerEvents: 'none' }} />

      <Handle type="target" position={Position.Bottom} id="bottom-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '25%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Bottom} id="bottom-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '50%', pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Bottom} id="bottom-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '75%', pointerEvents: 'none' }} />

      <Card className="border-2 shadow-lg">
        <CardHeader
          className={cn('pb-2 pt-2 cursor-move', this.getNodeColor())}
          onDoubleClick={() => this.handleMaximize(true)}
        >
          <CardTitle className={cn('flex items-center justify-between text-sm', this.getTextColor())}>
            <div className="flex items-center space-x-2 overflow-hidden">
              {this.getIcon()}
              <span className="truncate leading-[1.0]" dangerouslySetInnerHTML={{ __html: renderGtsNameWithBreak(this.displayLabel()) }} />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={this.handleToggleExpanded}
              className="h-6 w-6 p-0 nodrag"
            >
              {isExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </Button>
          </CardTitle>
        </CardHeader>

        {isExpanded && (
          <CardContent className="pt-0 p-2 nodrag">
            {(this.model?.entity?.file?.name || d.entity?.file?.name) && (
              <div className="mb-2 rounded border bg-muted/40 text-muted-foreground px-2 py-1 text-xs flex items-center justify-between overflow-hidden" style={{ textOverflow: 'ellipsis' }}>
                <div className="min-w-0 max-w-[90%] overflow-hidden">
                  <Popup closeDelay={200}>
                    <PopupTrigger>
                      <span className="block truncate cursor-default">{(this.model?.entity?.file?.name || d.entity?.file?.name)}</span>
                    </PopupTrigger>
                    <PopupContent side="bottom" copyableText={(this.model?.entity?.file?.path || d.entity?.file?.path)}>
                      {(this.model?.entity?.file?.path || d.entity?.file?.path) || ''}
                    </PopupContent>
                  </Popup>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 bg-gray-200"
                  onClick={this.handleToggleRawView}
                  title={rawView ? 'Switch to formatted view' : 'Switch to raw JSON'}
                >
                  {rawView ? <List className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            )}
            {(this.model?.validation || d.validation) && !(this.model?.validation || d.validation).valid && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded select-text cursor-text">
                <div className="text-xs font-medium text-red-800 mb-1">Validation Errors:</div>
                <div className="space-y-1">
                  {(this.model?.validation || d.validation).errors.map((error: any, index: number) => (
                    <div key={index} className="text-xs text-red-700 select-text cursor-text">
                      <span className="font-medium">{error.instancePath || '/'}</span>: {error.message}
                      {error.keyword && <span className="text-red-500 ml-1">({error.keyword})</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {rawView ? (
              <div className="max-h-96 overflow-auto rounded border select-text cursor-text">
                {this.renderCodeWithErrors(JSON.stringify((this.model?.entity?.content ?? d.entity?.content), null, 2))}
              </div>
            ) : (
              this.model?.properties && (
                <div
                  className="max-h-96 overflow-y-auto overflow-x-hidden pr-2"
                  onWheel={(e) => {
                    const element = e.currentTarget
                    const canScrollUp = element.scrollTop > 0
                    const canScrollDown = element.scrollTop < element.scrollHeight - element.clientHeight
                    if ((e.deltaY < 0 && canScrollUp) || (e.deltaY > 0 && canScrollDown)) {
                      e.stopPropagation()
                    }
                  }}
                  onTouchMove={(e) => {
                    const element = e.currentTarget
                    if (element.scrollHeight > element.clientHeight) {
                      const touch = e.touches[0]
                      if (touch && e.touches.length === 1) {
                        e.stopPropagation()
                      }
                    }
                  }}
                >
                  <PropertyViewer
                    properties={this.model.properties}
                    sectionStates={sectionStates}
                    onToggleSection={this.handleToggleSection}
                    validationErrors={this.model?.validation?.errors}
                  />
                </div>
              )
            )}
          </CardContent>
        )}
      </Card>

      {this.model?.isMaximized && overlayContainer && createPortal(
        (
          <div
            className="absolute inset-0 z-50 bg-black/10 animate-in fade-in-0 flex items-center justify-center"
            style={{ backdropFilter: 'blur(1px)' }}
            onClick={() => this.handleMaximize(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-[97%] h-[95%] bg-card rounded-lg shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 fade-in-0 duration-100"
            >
              <div className={cn('p-4 border-b rounded-t-lg', this.getNodeColor())}>
                <div className={cn('flex items-center justify-between text-base', this.getTextColor())}>
                  <div className="flex items-center space-x-2 overflow-hidden font-semibold">
                    {this.getIcon()}
                    <span className="truncate leading-[1.0]">{this.displayLabel()}</span>
                  </div>
                  <button
                    onClick={() => this.handleMaximize(false)}
                    className="p-1 rounded-full hover:bg-black/10"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
              <div className="flex-1 p-4 overflow-auto text-sm">
                {this.model?.entity?.file?.name && (
                  <div className="mb-2 rounded border bg-muted/40 text-muted-foreground px-2 py-1 text-xs flex items-center justify-between overflow-hidden" style={{ textOverflow: 'ellipsis' }}>
                    <span className="truncate cursor-default overflow-hidden">{this.model?.entity?.file?.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 bg-gray-200"
                      onClick={(e) => { e.stopPropagation(); this.handleToggleRawView() }}
                      title={(this.model?.rawView ? true : false) ? 'Switch to formatted view' : 'Switch to raw JSON'}
                    >
                      {(this.model?.rawView ? true : false) ? <List className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                )}
                {this.model?.validation && !this.model.validation.valid && (
                  <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded select-text cursor-text">
                    <div className="text-sm font-medium text-red-800 mb-2">Validation Errors:</div>
                    <div className="space-y-1">
                      {this.model.validation.errors.map((error: any, index: number) => (
                        <div key={index} className="text-sm text-red-700 select-text cursor-text">
                          <span className="font-medium">{error.instancePath || '/'}</span>: {error.message}
                          {error.keyword && <span className="text-red-500 ml-1">({error.keyword})</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(rawView ? true : false) ? (
                  <div className="h-[calc(100%-3rem)] overflow-auto rounded border">
                    {this.renderCodeWithErrors(JSON.stringify(this.model?.entity?.content, null, 2))}
                  </div>
                ) : (
                  this.model?.properties && (
                    <div className="h-[calc(100%-2rem)] overflow-y-auto overflow-x-hidden pr-2">
                      <PropertyViewer
                        properties={this.model.properties}
                        sectionStates={this.model.sections}
                        onToggleSection={this.handleToggleSection}
                        validationErrors={this.model?.validation?.errors}
                      />
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        ),
        overlayContainer
      )}

      {/* Source handles */}
      <Handle type="source" position={Position.Left} id="left-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '25%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Left} id="left-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '50%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Left} id="left-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '75%', pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Top} id="top-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '25%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Top} id="top-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '50%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Top} id="top-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '75%', pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Right} id="right-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '25%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Right} id="right-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '50%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Right} id="right-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ top: '75%', pointerEvents: 'none' }} />

      <Handle type="source" position={Position.Bottom} id="bottom-1" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '25%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-2" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '50%', pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-3" className="w-1 h-1 !bg-gray-300 opacity-50" style={{ left: '75%', pointerEvents: 'none' }} />
      </div>
    )
  }
}
