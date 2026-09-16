import * as vscode from 'vscode'
import * as path from 'path'
import * as YAML from 'yaml'
import * as jsonc from 'jsonc-parser'
import { ValidationError, DEFAULT_GTS_CONFIG, parseGtsFileContent, isYamlFileName } from '@gts/shared'
import { getLastScanFiles } from './scanStore'
import { getRegistry, rebuildRegistry, indexFile } from './registryStore'
import { isGtsCandidateFile } from './helpers'

let diagnosticCollection: vscode.DiagnosticCollection
let workspaceDiagnosticCollection: vscode.DiagnosticCollection
let isInitialScanComplete = false

const documentValidationErrors = new Map<string, ValidationError[]>()
const validationCompletedListeners = new Set<(uri: vscode.Uri) => void>()

export function getDocumentValidationErrors(uri: vscode.Uri): ValidationError[] {
  return documentValidationErrors.get(uri.toString()) || []
}

export function onValidationCompleted(listener: (uri: vscode.Uri) => void): vscode.Disposable {
  validationCompletedListeners.add(listener)
  return new vscode.Disposable(() => validationCompletedListeners.delete(listener))
}

function isPathUnderAnyRoot(filePath: string, roots: string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true
  for (const root of roots) {
    const rel = path.relative(root, filePath)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true
    }
  }
  return false
}

/**
 * Convert validation errors to VSCode diagnostics
 */
function validationErrorsToDiagnostics(errors: ValidationError[], document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []

  for (const error of errors) {
    console.log(`[GTS Validation] Processing error:`, {
      keyword: error.keyword,
      instancePath: error.instancePath,
      message: error.message,
      params: error.params
    })

    // Try to find the error location in the document
    let range: vscode.Range

    // Try to find position using instancePath (even if empty) or error-specific logic
    const position = findErrorPosition(document, error.instancePath || '', error)
    console.log(`[GTS Validation] Position found for path '${error.instancePath}':`, position ? `line ${position.start.line}` : 'null')

    if (position) {
      range = position
    } else {
      // Fallback to start of document
      console.log(`[GTS Validation] Using fallback position (start of document)`)
      range = new vscode.Range(0, 0, 0, 1)
    }

    const diagnostic = new vscode.Diagnostic(
      range,
      error.message,
      vscode.DiagnosticSeverity.Error
    )

    diagnostic.source = 'GTS'
    diagnostic.code = error.keyword
    diagnostics.push(diagnostic)
  }

  return diagnostics
}

/**
 * Find the range of an error in the document based on instancePath and error details
 */
function findErrorPosition(document: vscode.TextDocument, instancePath: string, error: ValidationError): vscode.Range | null {
  const text = document.getText()

  // Remove leading slash from instancePath (e.g., '/users/0/email' -> 'users/0/email')
  const path = instancePath.replace(/^\//, '')

  // 1. Required property missing: the property is not in data, highlight the parent object opening brace
  if (error.keyword === 'required' && error.params && 'missingProperty' in error.params) {
    if (!path) {
      // Error at root level - find first opening brace
      const rootMatch = text.match(/\{/)
      if (rootMatch && rootMatch.index !== undefined) {
        const pos = document.positionAt(rootMatch.index)
        return new vscode.Range(pos, pos.translate(0, 1))
      }
    } else {
      const position = findObjectAtPath(text, document, path)
      if (position) {
        return position
      }
    }
  }

  // 2. Additional properties error: highlight the unexpected property key
  if (error.keyword === 'additionalProperties' && error.params && 'additionalProperty' in error.params) {
    const additionalProp = (error.params as any).additionalProperty
    const keyRange = findKeyRangeAtInstancePath(document, instancePath, additionalProp)
    if (keyRange) {
      return keyRange
    }
    const searchPattern = keyRegex(additionalProp)
    const match = searchPattern.exec(text)
    if (match) {
      const quoteLen = match[1] ? 1 : 0
      const startPos = document.positionAt(match.index + quoteLen)
      const endPos = document.positionAt(match.index + quoteLen + additionalProp.length)
      return new vscode.Range(startPos, endPos)
    }
  }

  // 3. For any error carrying an instance path, underline the offending node.
  // The choice of what to underline is STRUCTURAL, not keyword-specific: a
  // scalar value (format/uuid/pattern/x-gts-abstract/x-gts-ref/type/enum on a
  // leaf, or the schema's own $id) is underlined directly; when the path
  // resolves to an object/array subschema (e.g. an OP#12 derivation error at
  // `/allOf/1/properties/level`, whose value is itself a schema) the property
  // key is underlined instead.
  if (instancePath && instancePath !== '/') {
    const valueRange = findValueRangeAtInstancePath(document, instancePath)
    if (valueRange) {
      return valueRange
    }
    const keyRange = findKeyRangeAtInstancePath(document, instancePath)
    if (keyRange) {
      return keyRange
    }
  }

  // 4. For gts:// prefix violations and x-gts-ref mismatches, highlight the
  // offending string value precisely.
  if ((error.keyword === 'gts-uri-prefix' || error.keyword === 'x-gts-ref') && error.params && 'value' in error.params) {
    const value = String((error.params as any).value)
    // Quoted (JSON, or a quoted YAML scalar) first, then bare YAML scalar.
    let idx = text.indexOf(`"${value}"`)
    let quoteLen = 1
    if (idx === -1) {
      idx = text.indexOf(`'${value}'`)
      quoteLen = idx !== -1 ? 1 : 0
    }
    if (idx === -1) {
      idx = text.indexOf(value)
      quoteLen = 0
    }
    if (idx !== -1) {
      const startPos = document.positionAt(idx + quoteLen)
      const endPos = document.positionAt(idx + quoteLen + value.length)
      return new vscode.Range(startPos, endPos)
    }
  }

  // 5. For schema errors without a resolvable instancePath, search by schemaId in params
  if (error.keyword === 'schema') {
    console.log(`[GTS Validation] Schema error detected, path='${path}'`)

    // If instancePath is empty, search by schemaId in params
    if (!path && error.params && 'schemaId' in error.params) {
      const schemaId = (error.params as any).schemaId as string
      console.log(`[GTS Validation] Searching for type field with value: ${schemaId}`)
      const position = findTypeFieldByValue(text, document, schemaId)
      console.log(`[GTS Validation] findTypeFieldByValue returned:`, position)
      if (position) {
        return position
      }
    } else if (path) {
      const position = findObjectAtPath(text, document, path)
      console.log(`[GTS Validation] findObjectAtPath returned:`, position)
      if (position) {
        return position
      }
    }
  }

  // 6. Fallback: try to find the property key using AST or quoted regex
  if (path) {
    const keyRange = findKeyRangeAtInstancePath(document, instancePath)
    if (keyRange) {
      return keyRange
    }
    const segments = path.split('/')
    const lastSegment = segments[segments.length - 1]

    if (lastSegment && !/^\d+$/.test(lastSegment)) {
      // Not an array index, try to find the property name
      const searchPattern = keyRegex(lastSegment)
      const match = searchPattern.exec(text)
      if (match) {
        const quoteLen = match[1] ? 1 : 0
        const startPos = document.positionAt(match.index + quoteLen)
        const endPos = document.positionAt(match.index + quoteLen + lastSegment.length)
        return new vscode.Range(startPos, endPos)
      }
    }
  }

  // Fallback: return null to use default position
  return null
}

/**
 * Find a "type" field with a specific value in the JSON
 * Returns a range highlighting the "type" field name
 */
function findTypeFieldByValue(text: string, document: vscode.TextDocument, typeValue: string): vscode.Range | null {
  console.log(`[GTS Validation] Searching for "type" field with value: ${typeValue}`)

  // Escape the typeValue for use in regex
  const escapedValue = escapeRegex(typeValue)

  // Search for: type: typeValue (key and/or value optionally quoted, so this
  // matches both JSON's `"type": "typeValue"` and YAML's bare `type: typeValue`)
  const searchPattern = new RegExp(`(["']?)type\\1\\s*:\\s*(["']?)${escapedValue}\\2`, 'g')
  const match = searchPattern.exec(text)

  if (match) {
    // Highlight the "type" property name (not the value)
    const typeKeyStart = match.index + (match[1] ? 1 : 0)
    const typeKeyEnd = typeKeyStart + 4 // "type" is 4 characters

    const startPos = document.positionAt(typeKeyStart)
    const endPos = document.positionAt(typeKeyEnd)

    console.log(`[GTS Validation] Found "type" field at line ${startPos.line}, col ${startPos.character}`)
    return new vscode.Range(startPos, endPos)
  }

  console.log(`[GTS Validation] Did not find "type" field with value: ${typeValue}`)
  return null
}

/**
 * Find an object in the JSON at the given path (handles array indices)
 * Returns a range highlighting the object's "id" or "type" field, or opening brace
 */
function findObjectAtPath(text: string, document: vscode.TextDocument, path: string): vscode.Range | null {
  if (!path) {
    // Root level - find first opening brace
    const rootMatch = text.match(/\{/)
    if (rootMatch && rootMatch.index !== undefined) {
      const pos = document.positionAt(rootMatch.index)
      return new vscode.Range(pos, pos.translate(0, 1))
    }
    return null
  }

  const segments = path.split('/')

  // Check if we're dealing with an array index at the root or deeper level
  if (segments.length === 1 && /^\d+$/.test(segments[0])) {
    // Root-level array, e.g., path = "1" means second item in array
    const arrayIndex = parseInt(segments[0], 10)
    return findNthObjectInArray(text, document, arrayIndex)
  }

  // For nested paths, navigate through the structure
  // For now, handle the simple case of array indices
  const lastSegment = segments[segments.length - 1]
  if (/^\d+$/.test(lastSegment)) {
    const arrayIndex = parseInt(lastSegment, 10)
    return findNthObjectInArray(text, document, arrayIndex)
  }

  // Try to find a property by name
  const searchPattern = new RegExp(`["']${escapeRegex(lastSegment)}["']\\s*:\\s*\\{`, 'g')
  const match = searchPattern.exec(text)
  if (match) {
    const pos = document.positionAt(match.index + 1)
    const endPos = document.positionAt(match.index + 1 + lastSegment.length)
    return new vscode.Range(pos, endPos)
  }

  return null
}

/**
 * Find the Nth object in a root-level array
 * Highlights the object's "id" or "type" field, or opening brace
 */
function findNthObjectInArray(text: string, document: vscode.TextDocument, index: number): vscode.Range | null {
  console.log(`[GTS Validation] findNthObjectInArray looking for index=${index}`)
  let braceCount = 0
  let objectCount = 0
  let inArray = false
  let currentObjectStart = -1

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (char === '[' && braceCount === 0) {
      inArray = true
      console.log(`[GTS Validation] Found array start at position ${i}`)
      continue
    }

    if (!inArray) continue

    if (char === '{') {
      if (braceCount === 0) {
        // Start of a new object at array level
        currentObjectStart = i
        console.log(`[GTS Validation] Found object start at position ${i}, objectCount=${objectCount}`)
      }
      braceCount++
    } else if (char === '}') {
      braceCount--
      if (braceCount === 0) {
        // End of object at array level
        console.log(`[GTS Validation] Object ${objectCount} ended at position ${i}`)
        if (objectCount === index) {
          // Found the target object, now find its "id" or "type" field
          const objectText = text.substring(currentObjectStart, i + 1)
          console.log(`[GTS Validation] Found target object at index ${index}, text length=${objectText.length}`)

          // Try to find "id" field first
          const idMatch = objectText.match(/"id"\s*:\s*"([^"]+)"/)
          if (idMatch && idMatch.index !== undefined) {
            const idStartPos = document.positionAt(currentObjectStart + idMatch.index + 1) // +1 to skip opening quote
            const idEndPos = document.positionAt(currentObjectStart + idMatch.index + 3) // "id" length
            console.log(`[GTS Validation] Highlighting "id" field at line ${idStartPos.line}`)
            return new vscode.Range(idStartPos, idEndPos)
          }

          // Try "type" field as fallback
          const typeMatch = objectText.match(/"type"\s*:\s*"([^"]+)"/)
          if (typeMatch && typeMatch.index !== undefined) {
            const typeStartPos = document.positionAt(currentObjectStart + typeMatch.index + 1)
            const typeEndPos = document.positionAt(currentObjectStart + typeMatch.index + 5) // "type" length
            console.log(`[GTS Validation] Highlighting "type" field at line ${typeStartPos.line}`)
            return new vscode.Range(typeStartPos, typeEndPos)
          }

          // Fallback: highlight opening brace
          const pos = document.positionAt(currentObjectStart)
          console.log(`[GTS Validation] Highlighting opening brace at line ${pos.line}`)
          return new vscode.Range(pos, pos.translate(0, 1))
        }
        objectCount++
      }
    }
  }

  console.log(`[GTS Validation] Did not find object at index ${index}, only found ${objectCount} objects`)
  return null
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a regex matching a quoted property key followed by `:`.
 * Requires quotes so it never accidentally matches bare words inside comments.
 */
function keyRegex(name: string): RegExp {
  const esc = escapeRegex(name)
  return new RegExp(`(["'])${esc}\\1\\s*:`, 'g')
}

/**
 * Split an AJV-style instancePath ("/tokens/2/subject_type") into path segments,
 * converting numeric segments into numbers so array indices resolve to the
 * correct list item rather than being treated as a property key. Empty segments
 * (from the leading slash or a "/" root path) are dropped.
 */
function instancePathSegments(instancePath: string): Array<string | number> {
  return instancePath
    .split('/')
    .filter(seg => seg.length > 0)
    .map(seg => (/^\d+$/.test(seg) ? Number(seg) : seg))
}

/**
 * Resolve the document range of a property key at a given instancePath.
 * If keyName is provided, searches for a child property with that name under instancePath.
 */
function findKeyRangeAtInstancePath(document: vscode.TextDocument, instancePath: string, keyName?: string): vscode.Range | null {
  const segments = instancePathSegments(instancePath)
  if (keyName) {
    segments.push(keyName)
  }
  if (segments.length === 0) return null

  const text = document.getText()
  const isYaml = document.languageId === 'yaml' || isYamlFileName(document.fileName)

  if (isYaml) {
    let doc: YAML.Document.Parsed
    try {
      doc = YAML.parseDocument(text)
    } catch {
      return null
    }
    if (doc.contents == null) return null

    const parentSegments = segments.slice(0, -1)
    const targetKey = String(segments[segments.length - 1])
    const parentNode = parentSegments.length === 0 ? doc.contents : doc.getIn(parentSegments, true)
    if (YAML.isMap(parentNode)) {
      const pair = parentNode.items.find(item => YAML.isScalar(item.key) && String(item.key.value) === targetKey)
      if (pair && YAML.isScalar(pair.key) && pair.key.range) {
        const [startOffset, endOffset] = pair.key.range
        const raw = text.slice(startOffset, endOffset)
        const quoteLen = raw.startsWith('"') || raw.startsWith("'") ? 1 : 0
        const start = startOffset + quoteLen
        const end = endOffset - quoteLen
        return new vscode.Range(document.positionAt(start), document.positionAt(end))
      }
    }
    return null
  }

  const root = jsonc.parseTree(text, undefined, { allowTrailingComma: true })
  if (!root) return null

  const node = jsonc.findNodeAtLocation(root, segments)
  if (node && node.parent && node.parent.type === 'property' && node.parent.children) {
    const keyNode = node.parent.children[0]
    if (keyNode) {
      let offset = keyNode.offset
      let length = keyNode.length
      if (keyNode.type === 'string') {
        offset += 1
        length = Math.max(0, length - 2)
      }
      return new vscode.Range(document.positionAt(offset), document.positionAt(offset + length))
    }
  }
  return null
}

/**
 * Resolve the document range of the *value* at a given instancePath, honoring
 * array indices. This is what lets repeated keys under different array items
 * (e.g. `subject_type` inside several `tokens`) each resolve to their own
 * occurrence instead of every error collapsing onto the first textual match.
 *
 * Returns null when the path cannot be resolved (e.g. multi-entity files whose
 * per-entity paths are not rooted at the document), so callers can fall back to
 * the coarser text-search strategies.
 */
function findValueRangeAtInstancePath(document: vscode.TextDocument, instancePath: string): vscode.Range | null {
  const segments = instancePathSegments(instancePath)
  if (segments.length === 0) return null

  const text = document.getText()
  const isYaml = document.languageId === 'yaml' || isYamlFileName(document.fileName)
  return isYaml
    ? findValueRangeYaml(text, document, segments)
    : findValueRangeJson(text, document, segments)
}

/** Resolve a value range by navigating the YAML CST to the node at `segments`. */
function findValueRangeYaml(text: string, document: vscode.TextDocument, segments: Array<string | number>): vscode.Range | null {
  let doc: YAML.Document.Parsed
  try {
    doc = YAML.parseDocument(text)
  } catch {
    return null
  }
  if (doc.contents == null) return null

  const node = doc.getIn(segments, true)
  if (!YAML.isScalar(node) || !node.range) return null

  const [startOffset, valueEndOffset] = node.range
  // Skip the opening quote (if any) so the range points at the string content.
  const raw = text.slice(startOffset, valueEndOffset)
  const quoteLen = raw.startsWith('"') || raw.startsWith("'") ? 1 : 0
  const valueStart = startOffset + quoteLen
  const value = String(node.value)

  const startPos = document.positionAt(valueStart)
  const endPos = document.positionAt(valueStart + value.length)
  return new vscode.Range(startPos, endPos)
}

/**
 * Resolve the document range of the *scalar value* at a given instancePath,
 * honoring array indices. Returns null when the node is not a scalar (an
 * object/array subschema — e.g. a derivation error pointing at a property whose
 * value is itself a schema), so callers can fall back to highlighting the key.
 */
function findValueRangeJson(text: string, document: vscode.TextDocument, segments: Array<string | number>): vscode.Range | null {
  const root = jsonc.parseTree(text, undefined, { allowTrailingComma: true })
  if (!root) return null

  const node = jsonc.findNodeAtLocation(root, segments)
  if (!node) return null
  // Only scalars have a meaningful "value" range to underline; objects/arrays
  // resolve to the property key instead (handled by findKeyRangeAtInstancePath).
  if (node.type === 'object' || node.type === 'array') return null

  let offset = node.offset
  let length = node.length
  // jsonc node offsets for strings include the surrounding quotes; strip them
  // so the range covers only the string content.
  if (node.type === 'string') {
    offset += 1
    length = Math.max(0, length - 2)
  }

  const startPos = document.positionAt(offset)
  const endPos = document.positionAt(offset + length)
  return new vscode.Range(startPos, endPos)
}

/**
 * Validate a document and update diagnostics
 */
export async function validateOpenDocument(document: vscode.TextDocument) {
  if (!isGtsCandidateFile(document)) {
    return
  }

  try {
    const text = document.getText()
    const fileName = path.basename(document.fileName)
    const filePath = document.uri.fsPath

    console.log(`[GTS Validation] Validating: ${filePath}`)

    // Parse the document content, choosing the parser by extension so YAML files
    // are not mis-parsed as JSONC.
    let content: any
    let parseErrorMessage: string | null = null
    try {
      content = parseGtsFileContent(fileName, text)
    } catch (parseError: any) {
      parseErrorMessage = parseError?.message || String(parseError)
      console.log(`[GTS Validation] Failed to parse ${isYamlFileName(fileName) ? 'YAML' : 'JSON'}: ${parseErrorMessage}`)
      // If parsing fails, store as text and let registry handle it
      content = text
    }

    // Use the shared, persistent registry as the resolution context so we don't
    // re-parse the whole workspace on every validation. Build it lazily if the
    // initial scan hasn't populated it yet.
    let registry = getRegistry()
    if (!registry) {
      registry = await rebuildRegistry(getLastScanFiles(), DEFAULT_GTS_CONFIG)
    }

    // Upsert the document's live (possibly unsaved) content into the registry.
    indexFile(filePath, fileName, content)

    // Re-read the registry state after indexing the current document so we see
    // any new invalid-file entry or updated entity list for this open buffer.
    registry = getRegistry() || registry

    let errors: ValidationError[] = []

    const invalid = registry.invalidFiles.get(filePath)

    if (parseErrorMessage) {
      errors = [{
        instancePath: '',
        schemaPath: '#',
        keyword: 'parse',
        message: `Invalid ${isYamlFileName(fileName) ? 'YAML' : 'JSON'}: ${parseErrorMessage}`,
        params: { error: parseErrorMessage }
      }]
    } else if (invalid?.validation && invalid.validation.errors.length > 0) {
      errors = invalid.validation.errors
    } else {
      // Only validate the entities defined in THIS document. Other files remain
      // indexed (for $ref / GTS-reference resolution) but are not re-validated.
      const fileSchemas = registry.jsonFileSchemas.get(filePath) || []
      const fileObjs = registry.jsonFileObjs.get(filePath) || []

      console.log(`[GTS Validation] Validating ${fileSchemas.length + fileObjs.length} entities in ${fileName}...`)
      for (const e of [...fileSchemas, ...fileObjs]) {
        await registry.validateEntity(e)
        if (e.validation && e.validation.errors.length > 0) {
          errors.push(...e.validation.errors)
        }
      }
    }

    // This document is now open and gets precise diagnostics; drop any coarse
    // background diagnostic so markers aren't duplicated.
    workspaceDiagnosticCollection?.delete(document.uri)

    if (errors.length > 0) {
      documentValidationErrors.set(document.uri.toString(), errors)
      const diagnostics = validationErrorsToDiagnostics(errors, document)
      diagnosticCollection.set(document.uri, diagnostics)
      console.log(`[GTS Validation] ✗ Got ${diagnostics.length} GTS diagnostics errors for ${fileName} - Errors:`, diagnostics.map(d => ({ message: d.message, range: d.range })))
    } else {
      documentValidationErrors.delete(document.uri.toString())
      diagnosticCollection.delete(document.uri)
      console.log(`[GTS Validation] ✓ No errors, cleared diagnostics for ${fileName}`)
    }

    for (const listener of validationCompletedListeners) {
      try {
        listener(document.uri)
      } catch (err) {
        console.error('[GTS Validation] Error in validation completed listener:', err)
      }
    }
  } catch (error) {
    console.error('[GTS Validation] ✗ Error validating document:', error)
    documentValidationErrors.delete(document.uri.toString())
    diagnosticCollection.delete(document.uri)
  }
}

/**
 * Validate all indexed entities and publish coarse diagnostics for files that are
 * not currently open in an editor. This makes unopened invalid files visible in
 * Explorer/Problems without replacing precise in-editor diagnostics.
 */
export async function validateWorkspaceInBackground(scopeRoots?: string[]): Promise<void> {
  const registry = getRegistry()
  if (!registry || !workspaceDiagnosticCollection) return

  const openPaths = new Set<string>()
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && isGtsCandidateFile(doc)) {
      openPaths.add(doc.uri.fsPath)
    }
  }

  const diagnosticsByPath = new Map<string, vscode.Diagnostic[]>()
  const addError = (filePath: string, error: ValidationError) => {
    if (openPaths.has(filePath)) return
    if (!isPathUnderAnyRoot(filePath, scopeRoots)) return
    const diagnostics = diagnosticsByPath.get(filePath) || []
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      error.message,
      vscode.DiagnosticSeverity.Error
    )
    diagnostic.source = 'GTS'
    diagnostic.code = error.keyword
    diagnostics.push(diagnostic)
    diagnosticsByPath.set(filePath, diagnostics)
  }

  // Files that failed parsing/indexing.
  for (const invalidFile of registry.invalidFiles.values()) {
    const errors = invalidFile.validation?.errors || []
    for (const error of errors) addError(invalidFile.path, error)
  }

  // Validate all indexed entities against current registry context.
  const entities = [...registry.jsonSchemas.values(), ...registry.jsonObjs.values()]
  for (const entity of entities) {
    await registry.validateEntity(entity)
    if (!entity.file?.path) continue
    const errors = entity.validation?.errors || []
    for (const error of errors) addError(entity.file.path, error)
  }

  const entries: Array<[vscode.Uri, vscode.Diagnostic[]]> = []
  for (const [filePath, diagnostics] of diagnosticsByPath.entries()) {
    entries.push([vscode.Uri.file(filePath), diagnostics])
  }
  workspaceDiagnosticCollection.set(entries)
}

/**
 * Validate a single file that is NOT open in an editor and publish coarse
 * (line-0) workspace diagnostics for it, using the shared registry as context.
 * Uses the single-URI overload of `set` so only this file's markers change.
 */
async function validateClosedFile(filePath: string): Promise<void> {
  const registry = getRegistry()
  if (!registry || !workspaceDiagnosticCollection) return

  // Entity validation itself is shared registry logic; here we only turn the
  // resulting errors into coarse (line-0) workspace diagnostics.
  await registry.validateFile(filePath)

  const diagnostics: vscode.Diagnostic[] = []
  const push = (error: ValidationError) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      error.message,
      vscode.DiagnosticSeverity.Error
    )
    diagnostic.source = 'GTS'
    diagnostic.code = error.keyword
    diagnostics.push(diagnostic)
  }

  const invalid = registry.invalidFiles.get(filePath)
  if (invalid?.validation && invalid.validation.errors.length > 0) {
    for (const error of invalid.validation.errors) push(error)
  } else {
    const fileSchemas = registry.jsonFileSchemas.get(filePath) || []
    const fileObjs = registry.jsonFileObjs.get(filePath) || []
    for (const entity of [...fileSchemas, ...fileObjs]) {
      for (const error of entity.validation?.errors || []) push(error)
    }
  }

  const uri = vscode.Uri.file(filePath)
  workspaceDiagnosticCollection.set(uri, diagnostics.length > 0 ? diagnostics : undefined)
}

/**
 * Re-read a (now-closed) file from disk and re-index it into the shared registry.
 *
 * When an editor closes, any unsaved buffer edits are discarded, so the registry
 * may still hold the stale live content that `validateOpenDocument` indexed. Re-
 * indexing from disk makes the subsequent closed-file validation reflect what is
 * actually on disk. No-op for non-file schemes or unreadable/deleted files.
 */
async function reindexClosedFileFromDisk(uri: vscode.Uri): Promise<void> {
  if (uri.scheme !== 'file') return
  try {
    const data = await vscode.workspace.fs.readFile(uri)
    const text = Buffer.from(data).toString('utf8')
    const name = path.basename(uri.fsPath)
    let content: any
    try { content = parseGtsFileContent(name, text) } catch { content = text }
    indexFile(uri.fsPath, name, content)
  } catch {
    // File may have been deleted/renamed; leave the registry as-is so the
    // watcher's delete handler can drop it.
  }
}

/**
 * Revalidate every file that depends on `changedPath` (instances of a changed
 * type, schemas derived from it, or entities that GTS-reference it). Open files
 * get precise in-editor diagnostics; closed files get coarse workspace markers.
 * This is what keeps derived types/instances in sync when a base file changes.
 */
export async function revalidateDependents(changedPath: string, previousIds?: Iterable<string>): Promise<void> {
  const registry = getRegistry()
  if (!registry) return

  // `previousIds` carries the ids the file defined *before* the edit so that a
  // renamed/removed id still revalidates whatever referenced its old id.
  const dependentPaths = registry.getDependentFilePaths(changedPath, previousIds)
  if (dependentPaths.size === 0) return

  const openByPath = new Map<string, vscode.TextDocument>()
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && isGtsCandidateFile(doc)) {
      openByPath.set(doc.uri.fsPath, doc)
    }
  }

  console.log(`[GTS Validation] Revalidating ${dependentPaths.size} dependents of ${path.basename(changedPath)}`)
  for (const dependentPath of dependentPaths) {
    const openDoc = openByPath.get(dependentPath)
    if (openDoc) {
      await validateOpenDocument(openDoc)
    } else {
      await validateClosedFile(dependentPath)
    }
  }
}

export function resetValidationDiagnostics(): void {
  documentValidationErrors.clear()
  diagnosticCollection?.clear()
  workspaceDiagnosticCollection?.clear()
}

export function initValidation(context: vscode.ExtensionContext) {
    console.log('[GTS Validation] Initializing validation system...')

    // Create diagnostic collection for validation errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('gts-validation')
    context.subscriptions.push(diagnosticCollection)
    workspaceDiagnosticCollection = vscode.languages.createDiagnosticCollection('gts-workspace')
    context.subscriptions.push(workspaceDiagnosticCollection)

    // Validate all open documents on activation
    const openDocs = vscode.workspace.textDocuments
    console.log(`[GTS Validation] Validating ${openDocs.length} open documents on activation`)
    openDocs.forEach(doc => {
      void validateOpenDocument(doc)
    })

    // Validate document when it's opened
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        console.log(`[GTS Validation] Document opened: ${doc.fileName} (language: ${doc.languageId})`)
        void validateOpenDocument(doc)
      })
    )

    // When a document is closed (e.g. a preview tab replaced by clicking another
    // file in the Explorer), drop its precise in-editor diagnostics and republish
    // the coarse workspace diagnostic so the file keeps showing as invalid in the
    // Explorer/tree. Without this the file would go green: validateOpenDocument
    // removed the workspace marker when it was opened, and nothing restores it.
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(async doc => {
        if (!isGtsCandidateFile(doc)) return
        console.log(`[GTS Validation] Document closed: ${doc.fileName}`)
        documentValidationErrors.delete(doc.uri.toString())
        diagnosticCollection.delete(doc.uri)
        if (doc.uri.scheme !== 'file') return
        await reindexClosedFileFromDisk(doc.uri)
        await validateClosedFile(doc.uri.fsPath)
      })
    )

    console.log('[GTS Validation] Validation system initialized successfully')
}
