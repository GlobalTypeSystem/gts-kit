import * as yaml from 'js-yaml'

/**
 * Parse YAML string.
 *
 * @param text - The YAML string to parse
 * @returns The parsed object
 * @throws Error if the YAML is invalid
 */
export function parseYAML(text: string): any {
  try {
    return yaml.load(text, { json: true })
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`YAML parse error: ${error.message}`)
    }
    throw new Error('YAML parse error: Unknown error')
  }
}

/**
 * Safely parse YAML with fallback
 * Returns null if parsing fails
 */
export function tryParseYAML(text: string): any | null {
  try {
    return parseYAML(text)
  } catch {
    return null
  }
}
