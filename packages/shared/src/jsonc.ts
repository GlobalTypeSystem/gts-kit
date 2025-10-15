import * as jsonc from 'jsonc-parser'

/**
 * Parse JSONC (JSON with Comments) string.
 * Supports single-line comments, multi-line comments, and trailing commas.
 * 
 * @param text - The JSONC string to parse
 * @returns The parsed JSON object
 * @throws Error if the JSONC is invalid
 */
export function parseJSONC(text: string): any {
  const errors: jsonc.ParseError[] = []
  const result = jsonc.parse(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
  })
  
  if (errors.length > 0) {
    const errorMessages = errors.map(err => {
      const errorCode = jsonc.printParseErrorCode(err.error)
      return `${errorCode} at offset ${err.offset} (length: ${err.length})`
    })
    throw new Error(`JSONC parse error: ${errorMessages.join(', ')}`)
  }
  
  return result
}

/**
 * Safely parse JSONC with fallback
 * Returns null if parsing fails
 */
export function tryParseJSONC(text: string): any | null {
  try {
    return parseJSONC(text)
  } catch {
    return null
  }
}
