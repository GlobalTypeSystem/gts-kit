import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertCircle } from 'lucide-react'
import { GTS_TYPE_REGEX, GTS_OBJ_REGEX, GTS_COLORS, analyzeGtsIdForStyling, JsonRegistry, type GtsStyledSegment } from '@gts/shared'
import { TIMING } from '@/lib/timing'
import { PropertyInfo } from '@/lib/schemaParser'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'

interface ValidationError {
  instancePath: string
  message: string
  keyword?: string
  params?: any
}

/**
 * Render a GTS ID value with proper color-coding for each part
 */
function renderGtsValue(value: string, registry: JsonRegistry | null) {
  // Remove quotes if present
  const raw = value.replace(/^"/, '').replace(/"$/, '')

  // Check if this looks like a GTS ID
  if (!raw.startsWith('gts.')) {
    return <span>{value}</span>
  }

  // Analyze the GTS ID for styling
  const analysis = analyzeGtsIdForStyling(raw, (entityId: string) => {
    if (!registry) return { exists: false }
    const schema = registry.jsonSchemas.get(entityId)
    const obj = registry.jsonObjs.get(entityId)
    if (schema) return { exists: true, isSchema: true }
    if (obj) return { exists: true, isSchema: false }
    return { exists: false }
  })

  // If invalid format, show as error
  if (!analysis.isValid) {
    return (
      <span
        className="rounded px-1"
        style={{
          color: GTS_COLORS.invalid.foreground,
          backgroundColor: GTS_COLORS.invalid.background
        }}
      >
        {value}
      </span>
    )
  }

  // Render each segment with appropriate styling
  const openQuote = value.startsWith('"') ? '"' : ''
  const closeQuote = value.endsWith('"') ? '"' : ''

  return (
    <>
      {openQuote}
      {analysis.segments.map((segment: GtsStyledSegment, idx: number) => {
        let bgColor: string
        let textColor: string

        if (segment.type === 'schema') {
          bgColor = '#dbeafe' // blue-100
          textColor = '#1e40af' // blue-800
        } else if (segment.type === 'instance') {
          bgColor = '#dcfce7' // green-100
          textColor = '#166534' // green-800
        } else {
          bgColor = '#fee2e2' // red-100
          textColor = '#991b1b' // red-800
        }

        return (
          <span
            key={idx}
            className="rounded px-0.5"
            style={{ backgroundColor: bgColor, color: textColor }}
          >
            {segment.text}
          </span>
        )
      })}
      {closeQuote}
    </>
  )
}

/**
 * Render an arbitrary text line and inline-highlight any GTS IDs it contains
 * using the same styling as renderGtsValue().
 */
function renderDescriptionWithGts(text: string, registry: JsonRegistry | null) {
  const parts: Array<JSX.Element> = []
  // A permissive detector for GTS-like tokens in plain text
  const regex = /gts\.[A-Za-z0-9_\.]+(?:~[A-Za-z0-9_\.]+)?~?/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (start > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, start)}</span>)
    }
    parts.push(<span key={`g-${start}`}>{renderGtsValue(match[0], registry)}</span>)
    lastIndex = end
  }
  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>)
  }
  return <>{parts}</>
}

interface PropertyViewerProps {
  properties: PropertyInfo[]
  level?: number
  basePath?: string
  sectionStates?: Record<string, boolean>
  onToggleSection?: (path: string, open: boolean) => void
  validationErrors?: ValidationError[]
  registry?: JsonRegistry | null
}

export function PropertyViewer({ properties, level = 0, basePath = '', sectionStates, onToggleSection, validationErrors, registry = null }: PropertyViewerProps) {
  return (
    <div className="space-y-0">
      {properties.map((property, index) => (
        <PropertyItem
          key={`${property.name}-${index}`}
          property={property}
          level={level}
          pathKey={basePath ? `${basePath}/${property.name}` : property.name}
          sectionStates={sectionStates}
          onToggleSection={onToggleSection}
          validationErrors={validationErrors}
          registry={registry}
        />
      ))}
    </div>
  )
}

interface PropertyItemProps {
  property: PropertyInfo
  level: number
  pathKey: string
  sectionStates?: Record<string, boolean>
  onToggleSection?: (path: string, open: boolean) => void
  validationErrors?: ValidationError[]
  registry?: JsonRegistry | null
}

function PropertyItem({ property, level, pathKey, sectionStates, onToggleSection, validationErrors, registry = null }: PropertyItemProps) {
  const [localOpen, setLocalOpen] = useState(level < 2) // Auto-expand first 2 levels
  const isOpen = (sectionStates && pathKey in sectionStates) ? !!sectionStates[pathKey] : localOpen
  const [copied, setCopied] = useState(false)
  const hasChildren = property.children && property.children.length > 0
  const indent = level * 16

  // Check if this property has validation errors
  const propertyPath = `/${pathKey}`

  const normalizeInstancePath = (p: string): string => {
    if (!p) return p
    // Collapse /properties/ segments used by Ajv
    let out = p.replace(/\/properties\//g, '/')
    // Convert bracket indices to pointer-style segments: allOf[1] -> allOf/1
    out = out.replace(/\[(\d+)\]/g, '/$1')
    // Iteratively strip trailing leaf nodes that refer to annotations or sub-keys
    // like /x-*, /type, /const, /$ref, /items
    const tail = /\/(x-[^/]+|type|const|\$ref|items)$/
    // Guard loop count to avoid infinite replaces
    let i = 0
    while (tail.test(out) && i++ < 10) {
      out = out.replace(tail, '')
    }
    return out
  }

  const propertyPathTree = normalizeInstancePath(propertyPath)

  const propertyErrors = validationErrors?.filter(err => {
    // Normalize error paths
    const errPath = err.instancePath || ''
    const errNorm = normalizeInstancePath(errPath.trim())
    const errParentNorm = normalizeInstancePath(errPath.trim().replace(/\/x-[^/]+$/, ''))

    // Direct matches (raw and normalized)
    if (errPath === propertyPath) return true
    if (errNorm === propertyPathTree) return true

    // Parent of /x-* annotation should map to the property itself
    if (errParentNorm === propertyPathTree) return true

    // Handle additionalProperties errors where instancePath is parent but message contains property name
    // e.g., "must NOT have additional property 'retention2'"
    if (err.keyword === 'additionalProperties' && err.message) {
      const match = err.message.match(/must NOT have additional property ['"]([^'"]+)['"]/)
      if (match && match[1] === property.name) {
        return true
      }
    }

    return false
  }) || []
  const hasError = propertyErrors.length > 0

  const getTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case 'string':
        return 'text-green-600'
      case 'number':
      case 'integer':
        return 'text-blue-600'
      case 'boolean':
        return 'text-purple-600'
      case 'array':
        return 'text-orange-600'
      case 'object':
        return 'text-red-600'
      case '$ref':
        return 'text-indigo-600'
      case 'schema':
      case 'allof':
      case 'oneof':
      case 'anyof':
        return 'text-cyan-600'
      default:
        return 'text-gray-600'
    }
  }

  const formatValue = (value: any) => {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (typeof value === 'string') return `"${value}"`
    if (typeof value === 'object') return Array.isArray(value) ? '[...]' : '{...}'
    return String(value)
  }

  const isGtsType = property.isGtsType || GTS_TYPE_REGEX.test(property.value)
  const isGtsObj = property.isGtsObj || GTS_OBJ_REGEX.test(property.value)
  const showGts = isGtsType || isGtsObj

  return (
    <div className="w-full">
      <Collapsible
        open={isOpen}
        onOpenChange={(open) => {
          if (onToggleSection) onToggleSection(pathKey, open)
          if (!sectionStates) setLocalOpen(open)
        }}
      >
        <div
          className={cn(
            "flex items-start py-0.5 rounded px-1",
            hasError ? "bg-red-50 hover:bg-red-100 border-l-2 border-red-500" : "hover:bg-accent/50"
          )}
          style={{ paddingLeft: `${indent}px` }}
          title={hasError ? propertyErrors.map(e => e.message).join('; ') : property.name}
        >
          <div className="flex items-start pt-1" style={{ minWidth: '15px' }}>
            {hasChildren ? (
              <CollapsibleTrigger className="flex items-center justify-center w-4 h-4">
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </CollapsibleTrigger>
            ) : (
              <div className="w-4" />
            )}
          </div>
          <div className="flex items-start flex-1 min-w-0 ml-1">
            <div className="flex flex-col min-w-0">
              <div className="flex items-center space-x-1 min-w-0">
                {hasError && (
                  <AlertCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                )}
                <span className={cn(
                  "font-medium text-sm whitespace-nowrap select-text cursor-text",
                  property.required && "font-semibold"
                )}>
                  {property.name}
                </span>
                {(!isGtsType && !isGtsObj) && (
                  <span className={cn(
                    "text-xs px-1.5 py-0 rounded font-mono whitespace-nowrap",
                    getTypeColor(property.type)
                  )}>
                    {property.type}
                  </span>
                )}
                {property.required && (
                  <span className="text-xs bg-gray-100 text-gray-800 px-1.5 py-0 rounded whitespace-nowrap">
                    required
                  </span>
                )}

                {(isGtsObj || isGtsType) && property.value !== undefined && (
                  <span
                    className="text-xs px-1.5 py-0 rounded whitespace-nowrap overflow-hidden inline-flex items-center gap-0.5"
                    style={{ cursor: 'copy', textOverflow: 'ellipsis' }}
                    title={String(property.value)}
                    onDoubleClick={async (e) => {
                      e.stopPropagation()
                      try {
                        await navigator.clipboard.writeText(String(property.value))
                        setCopied(true)
                        setTimeout(() => setCopied(false), TIMING.COPY_INDICATOR_DURATION)
                      } catch {}
                    }}
                  >
                    {renderGtsValue(String(property.value), registry)}
                  </span>
                )}

                {!showGts && property.value !== undefined && (
                  <span
                    className="text-xs text-muted-foreground font-mono truncate"
                    style={{ cursor: 'copy', textOverflow: 'ellipsis' }}
                    title={String(property.value)}
                    onDoubleClick={async (e) => {
                      e.stopPropagation()
                      try {
                        await navigator.clipboard.writeText(String(property.value))
                        setCopied(true)
                        setTimeout(() => setCopied(false), TIMING.COPY_INDICATOR_DURATION)
                      } catch {}
                    }}
                  >
                    = {formatValue(property.value)}
                  </span>
                )}
                {copied && (
                  <span className="ml-1 text-[10px] text-green-600 z-10" style={{ right: '0px' }}>copied</span>
                )}
              </div>
              {property.description && (
                <div className={cn(
                  "text-xs text-muted-foreground py-0 px-0 leading-[0.95] relative -top-px mt-0 pt-0 pb-1"
                )}>
                  {property.description.split('\n').map((line, index) => (
                    <div key={index} className={index > 0 ? 'mt-1' : undefined}>
                      {renderDescriptionWithGts(line, registry)}
                    </div>
                  ))}
                </div>
              )}
              {hasError && (
                <div className="text-xs text-red-700 mt-1 px-1.5 py-0.5 bg-red-100 rounded border border-red-200">
                  {propertyErrors.map((error, idx) => (
                    <div key={idx} className="select-text cursor-text">
                      {error.message}
                      {error.keyword && <span className="text-red-500 ml-1">({error.keyword})</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>

        {hasChildren && (
          <CollapsibleContent>
            <PropertyViewer
              properties={property.children!}
              level={level + 1}
              basePath={pathKey}
              sectionStates={sectionStates}
              onToggleSection={onToggleSection}
              validationErrors={validationErrors}
              registry={registry}
            />
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  )
}
