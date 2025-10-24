import type { CSSProperties } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import type { Language } from 'prism-react-renderer'
import { GTS_COLORS, analyzeGtsIdForStyling, JsonRegistry, type GtsStyledSegment, type ValidationIssues, GTS_REGEX, findSimilarEntityIds } from '@gts/shared'
import { Popup, PopupTrigger, PopupContent } from '@/components/ui/popup'

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

    // If invalid format, show as error with detailed tooltip
    if (!analysis.isValid) {
      // Check if it's a valid GTS format according to regex
      const isValidFormat = GTS_REGEX.test(raw)

      // Build detailed error message
      let errorMessage = `⚠️ Invalid GTS ID Format!\n\nID: ${raw}\n\n`

      if (!isValidFormat) {
        errorMessage += `This string starts with "gts." but doesn't match the valid GTS ID pattern.\n\n`
        errorMessage += `Expected pattern:\ngts.<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>[.<MIN>[~...]]\n\n`
        errorMessage += `Where:\n`
        errorMessage += `- <VENDOR>: Vendor name\n`
        errorMessage += `- <PACKAGE>: Package name\n`
        errorMessage += `- <NAMESPACE>: Namespace name\n`
        errorMessage += `- <TYPE>: Type or instance name\n`
        errorMessage += `- <MAJOR>: Major version\n`
        errorMessage += `- <MINOR>: Minor version (optional)\n\n`
      }

      // Get similar entity suggestions if registry is available
      if (registry) {
        const allEntityIds = [
          ...Array.from(registry.jsonSchemas.keys()),
          ...Array.from(registry.jsonObjs.keys())
        ].filter(id => GTS_REGEX.test(id)) // Only suggest valid GTS IDs

        const suggestions = findSimilarEntityIds(raw, allEntityIds, 3)

        if (suggestions.length > 0) {
          errorMessage += `Did you mean:\n`
          suggestions.forEach((suggestion, idx) => {
            const entity = registry.jsonSchemas.get(suggestion) || registry.jsonObjs.get(suggestion)
            const entityType = entity?.isSchema ? '📘 Schema' : '📄 Instance'
            errorMessage += `${idx + 1}. ${entityType}: ${suggestion}\n`
          })
        } else {
          errorMessage += `No similar entities found in the registry.`
        }
      }

      console.log('GTS ID Format Error:', errorMessage)

      return (
        <Popup>
          <PopupTrigger>
            <span
              className="text-red-400"
              style={{ textDecoration: 'underline wavy red', cursor: 'help' }}
            >
              {text}
            </span>
          </PopupTrigger>
          <PopupContent side="top" className="border-red-700">
            {errorMessage}
          </PopupContent>
        </Popup>
      )
    }

    // Render styled segments
    const hasQuotes = text.startsWith('"')
    return (
      <>
        {hasQuotes && '"'}
        {analysis.segments.map((segment: GtsStyledSegment, idx: number) => {
          let style: CSSProperties
          let tooltip: string | undefined

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
            // Invalid segment - entity not found
            style = {
              color: GTS_COLORS.invalid.foreground,
              backgroundColor: GTS_COLORS.invalid.background
            }

            // Build detailed error message for missing entity
            let errorMessage = `⚠️ GTS Entity Not Found!\n\nID: ${segment.text}\n\n`

            // Get similar entity suggestions if registry is available
            if (registry) {
              const allEntityIds = [
                ...Array.from(registry.jsonSchemas.keys()),
                ...Array.from(registry.jsonObjs.keys())
              ].filter(id => GTS_REGEX.test(id)) // Only suggest valid GTS IDs

              const suggestions = findSimilarEntityIds(segment.text, allEntityIds, 3)

              if (suggestions.length > 0) {
                errorMessage += `Did you mean:\n`
                suggestions.forEach((suggestion, idx) => {
                  const entity = registry.jsonSchemas.get(suggestion) || registry.jsonObjs.get(suggestion)
                  const entityType = entity?.isSchema ? '📘 Schema' : '📄 Instance'
                  errorMessage += `${idx + 1}. ${entityType}: ${suggestion}\n`
                })
              } else {
                errorMessage += `No similar entities found in the registry.`
              }
            }

            tooltip = errorMessage
          }

          return (
            <span
              key={idx}
              className={`rounded px-0.5 mx-[0.1em] ${segment.type === 'invalid' ? 'cursor-help' : ''}`}
              style={style}
              title={tooltip}
            >
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
