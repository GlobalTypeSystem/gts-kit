import type { CSSProperties } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import type { Language, PrismTheme } from 'prism-react-renderer'
import { GTS_OBJ_REGEX, GTS_TYPE_REGEX } from '@gts/shared'

interface JsonCodeProps {
  code: string
  language?: Language
  className?: string
}

export function JsonCode({ code, language = 'json', className }: JsonCodeProps) {
  const safeCode = typeof code === 'string' ? code : (code == null ? '' : String(code))
  const renderWithGtsHighlights = (text: string) => {
    // Remove surrounding quotes if present to test the raw value
    const raw = text.replace(/^"/, '').replace(/"$/, '')
    if (GTS_TYPE_REGEX.test(raw)) {
      return (
        <span className="text-sky-200 bg-sky-700 rounded p-1">{text}</span>
      )
    }
    if (GTS_OBJ_REGEX.test(raw)) {
      return (
        <span className="text-green-200 bg-green-700 rounded p-1">{text}</span>
      )
    }
    return <span>{text}</span>
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
