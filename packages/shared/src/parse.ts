import { parseJSONC } from './jsonc.js'
import { parseYAML } from './yaml.js'

/**
 * Whether the given file name denotes a YAML document (`.yaml` / `.yml`).
 */
export function isYamlFileName(fileName: string | undefined | null): boolean {
  if (!fileName) return false
  const lower = fileName.toLowerCase()
  return lower.endsWith('.yaml') || lower.endsWith('.yml')
}

/**
 * Parse a GTS entity file's raw text using the parser appropriate for its
 * extension: YAML for `.yaml`/`.yml`, otherwise JSONC (JSON with comments).
 *
 * This is the single place that maps a file name to a content parser so every
 * app (web, server, electron, VS Code extension) and the JsonFile model stay
 * consistent and YAML files are never mis-parsed as JSONC.
 *
 * @throws Error if the text cannot be parsed by the chosen parser.
 */
export function parseGtsFileContent(fileName: string | undefined | null, text: string): any {
  return isYamlFileName(fileName) ? parseYAML(text) : parseJSONC(text)
}
