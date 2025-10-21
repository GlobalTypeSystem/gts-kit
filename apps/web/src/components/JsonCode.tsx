import type { CSSProperties } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import type { Language } from 'prism-react-renderer'
import { GTS_COLORS, analyzeGtsIdForStyling, JsonRegistry, type GtsStyledSegment, type ValidationIssues } from '@gts/shared'

interface JsonCodeProps {
  code: string
  language?: Language
  className?: string
  registry?: JsonRegistry | null
  validationIssues?: ValidationIssues
}

export function JsonCode({ code, language = 'json', className, registry = null, validationIssues }: JsonCodeProps) {
  const safeCode = typeof code === 'string' ? code : (code == null ? '' : String(code))

  // Build a map of line numbers to validation error messages
  const errorLineMessages = new Map<number, string[]>()
  if (validationIssues) {
    validationIssues.forEach((issue) => {
      if (issue.type === 'line') {
        // Add all lines in the range
        // lineStart and lineEnd are 1-based and inclusive
        for (let lineNum = issue.lineStart; lineNum <= issue.lineEnd; lineNum++) {
          const messages = errorLineMessages.get(lineNum) || []
          messages.push(issue.message)
          errorLineMessages.set(lineNum, messages)
        }
      }
    })
  }

  // Define GTS highlighting function - returns JSX for GTS IDs, null for non-GTS
  const renderGtsOverlay = (text: string): React.ReactNode => {
    // Remove surrounding quotes if present to test the raw value
    const raw = text.replace(/^"/, '').replace(/"$/, '')

    // Check if this looks like a GTS ID
    if (!raw.startsWith('gts.')) {
      return null // Not a GTS ID, no overlay needed
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
          className="text-red-400"
          style={{ textDecoration: 'underline wavy red' }}
        >
          {text}
        </span>
      )
    }

    // Render styled segments
    const hasQuotes = text.startsWith('"')
    return (
      <>
        {hasQuotes && '"'}
        {analysis.segments.map((segment: GtsStyledSegment, idx: number) => {
          let style: CSSProperties
          if (segment.type === 'schema') {
            style = {
              color: GTS_COLORS.schema.foreground,
              backgroundColor: GTS_COLORS.schema.background
            }
          } else if (segment.type === 'instance') {
            style = {
              color: GTS_COLORS.instance.foreground,
              backgroundColor: GTS_COLORS.instance.background
            }
          } else {
            style = {
              color: GTS_COLORS.invalid.foreground,
              backgroundColor: GTS_COLORS.invalid.background
            }
          }

          return (
            <span key={idx} className="rounded px-0.5 mx-[0.1em]" style={style}>
              {segment.text}
            </span>
          )
        })}
        {hasQuotes && '"'}
      </>
    )
  }

  // Always render with Prism syntax highlighting + GTS highlights
  // If there are JSON parse errors, we'll overlay inline spans on top of the Prism tokens below
  return (
    <div className={`h-full rounded-md overflow-auto bg-[#011627] ${className || ''}`}>
      <Highlight theme={themes.nightOwl} code={safeCode} language={language}>
        {({ className: cls, style, tokens, getLineProps, getTokenProps }: {
          className: string
          style: CSSProperties
          tokens: any[][]
          getLineProps: (input: any) => any
          getTokenProps: (input: any) => any
        }) => (
          <pre className={`${cls} m-0 p-3 text-xs leading-5 select-text cursor-text`} style={style}>
            {tokens.map((line: any[], i: number) => {
              const lineProps = getLineProps({ line })
              // Convert 0-based index to 1-based line number for lookup
              const errorMessages = errorLineMessages.get(i + 1)
              const hasError = errorMessages && errorMessages.length > 0

              return (
              <div
                key={i}
                {...lineProps}
                title={hasError ? errorMessages.join('\n') : undefined}
                style={{
                  ...lineProps.style,
                  backgroundColor: hasError ? 'rgba(220, 38, 38, 0.3)' : lineProps.style?.backgroundColor,
                  borderLeft: hasError ? '3px solid #dc2626' : 'none',
                  paddingLeft: hasError ? '0px' : lineProps.style?.paddingLeft,
                  left: hasError ? '-2px' : lineProps.style?.left,
                  position: 'relative',
                  cursor: hasError ? 'help' : lineProps.style?.cursor
                }}
              >
                {line.map((token: any, key: number) => {
                  const props = getTokenProps({ token })
                  const types: string[] = token.types || (token.type ? [token.type] : [])
                  const isString = types.includes('string')
                  const isProperty = types.includes('property')

                  // For string values (not property names), check if GTS overlay exists
                  if (isString && !isProperty && typeof token.content === 'string') {
                    const gtsOverlay = renderGtsOverlay(token.content)

                    if (gtsOverlay) {
                      // GTS ID detected - render overlay INSTEAD of Prism styling
                      // The overlay has its own colors that override Prism
                      return <span key={key}>{gtsOverlay}</span>
                    }

                    // Not a GTS ID - use Prism styling
                    return <span key={key} className={props.className} style={props.style}>{props.children}</span>
                  }

                  // For all other tokens (property names, punctuation, etc) - use Prism styling
                  return <span key={key} className={props.className} style={props.style}>{props.children}</span>
                })}
              </div>
              )
            })}
          </pre>
        )}
      </Highlight>
    </div>
  )
}

export default JsonCode
