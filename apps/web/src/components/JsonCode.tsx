import type { CSSProperties } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import type { Language, PrismTheme } from 'prism-react-renderer'
import { GTS_COLORS, analyzeGtsIdForStyling, JsonRegistry, type GtsStyledSegment, type ValidationIssues, type OffsetValidationIssue, type LineValidationIssue } from '@gts/shared'

interface JsonCodeProps {
  code: string
  language?: Language
  className?: string
  registry?: JsonRegistry | null
  validationIssues?: ValidationIssues
}

export function JsonCode({ code, language = 'json', className, registry = null, validationIssues }: JsonCodeProps) {
  const safeCode = typeof code === 'string' ? code : (code == null ? '' : String(code))

  // If we have validation issues, render with error highlighting
  if (validationIssues && validationIssues.length > 0) {
    // Check if we have offset-based issues (JSONC parse errors)
    const offsetIssues = validationIssues.filter((issue): issue is OffsetValidationIssue => issue.type === 'offset')

    if (offsetIssues.length > 0) {
      // Render with character-level error highlighting
      const segments: Array<{ text: string; isError: boolean; message?: string }> = []
      let lastIndex = 0

      offsetIssues.sort((a, b) => a.start - b.start).forEach((issue) => {
        if (issue.start > lastIndex) {
          segments.push({ text: safeCode.substring(lastIndex, issue.start), isError: false })
        }
        segments.push({
          text: safeCode.substring(issue.start, issue.end),
          isError: true,
          message: issue.message
        })
        lastIndex = issue.end
      })

      if (lastIndex < safeCode.length) {
        segments.push({ text: safeCode.substring(lastIndex), isError: false })
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

    // Otherwise, render with line-based error highlighting
    const lineIssues = validationIssues.filter((issue): issue is LineValidationIssue => issue.type === 'line')
    const lines = safeCode.split('\n')
    const errorLines = new Map<number, Array<{ message: string; keyword?: string }>>()

    lineIssues.forEach((issue) => {
      for (let i = issue.lineStart; i <= issue.lineEnd; i++) {
        if (!errorLines.has(i)) {
          errorLines.set(i, [])
        }
        errorLines.get(i)!.push({
          message: issue.message,
          keyword: issue.keyword
        })
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

  // No validation issues - render with GTS highlighting
  const renderWithGtsHighlights = (text: string) => {
    // Remove surrounding quotes if present to test the raw value
    const raw = text.replace(/^"/, '').replace(/"$/, '')

    // Check if this looks like a GTS ID
    if (!raw.startsWith('gts.')) {
      return <span>{text}</span>
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
          {text}
        </span>
      )
    }

    // Render each segment with appropriate styling
    const openQuote = text.startsWith('"') ? '"' : ''
    const closeQuote = text.endsWith('"') ? '"' : ''

    return (
      <span>
        {openQuote}
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
            <span key={idx} className="rounded px-0.5" style={style}>
              {segment.text}
            </span>
          )
        })}
        {closeQuote}
      </span>
    )
  }

  return (
    <div className={`h-full rounded-md overflow-auto bg-[#011627] ${className || ''}`}>
      <Highlight theme={themes.nightOwl as PrismTheme} code={safeCode} language={language}>
        {({ className: cls, style, tokens, getLineProps, getTokenProps }: {
          className: string
          style: CSSProperties
          tokens: any[][]
          getLineProps: (input: any) => any
          getTokenProps: (input: any) => any
        }) => (
          <pre className={`${cls} m-0 p-3 text-xs leading-5 select-text cursor-text`} style={style}>
            {tokens.map((line: any[], i: number) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token: any, key: number) => {
                  const props = getTokenProps({ token })
                  // Prism tokens have types; we only want to process JSON string values, not property names
                  const types: string[] = token.types || (token.type ? [token.type] : [])
                  const isString = types.includes('string')
                  const isProperty = types.includes('property')
                  if (isString && !isProperty && typeof token.content === 'string') {
                    return (
                      <span key={key} className={props.className} style={props.style}>
                        {renderWithGtsHighlights(token.content)}
                      </span>
                    )
                  }
                  return <span key={key} {...props} />
                })}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  )
}

export default JsonCode
