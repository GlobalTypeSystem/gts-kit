import * as vscode from 'vscode'
import { JsonRegistry, GTS_REGEX, GTS_COLORS, GTS_URI_PREFIX, parseGtsIdParts, findSimilarEntityIds, normalizeGtsId, checkGtsUriPrefix } from '@gts/shared'
import type { GtsPrefixIssue } from '@gts/shared'
import { getRegistry } from './registryStore'
import * as jsonc from 'jsonc-parser'

/**
 * Represents a GTS ID reference found in the document
 */
interface GtsIdReference {
  /** Canonical GTS ID with any gts:// prefix stripped (used for lookups). */
  id: string
  /** The original, un-normalized string value as written in the document. */
  rawValue: string
  /** Length of the gts:// prefix present in rawValue (0 when absent). */
  uriPrefixLength: number
  /** The JSON leaf field name this value is assigned to (e.g. "$id", "type"). */
  fieldName: string
  range: vscode.Range
  sourcePath: string
  isValid: boolean // Whether the ID matches GTS_REGEX
  /** gts:// prefix problem for this value's field, if any. */
  urlPrefixIssue: GtsPrefixIssue | null
}

/**
 * Escape markdown special characters, especially tildes
 */
function escapeMarkdown(text: string): string {
  // Escape tildes and other markdown special characters
  return text
    .replace(/~/g, '\\~')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
}

/**
 * Get workspace-relative path from absolute path
 */
function getRelativePath(absolutePath: string): string {
  const workspaceFolders = require('vscode').workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return absolutePath
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath
  if (absolutePath.startsWith(workspaceRoot)) {
    return absolutePath.substring(workspaceRoot.length + 1)
  }

  return absolutePath
}

/**
 * Find the line number where a JSON entity is defined in its file
 */
function findEntityLineInFile(filePath: string, entityId: string): number {
  try {
    const fs = require('fs')
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')

    // Look for the entity ID in the file
    // It could be in various fields like "$id", "id", "type", etc.
    let foundLine = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes(entityId)) {
        foundLine = i
        break
      }
    }

    if (foundLine === -1) {
      return 0 // Not found, default to first line
    }

    // Found the entity ID, now find the start of the JSON object
    // Go backwards to find the opening brace
    let braceCount = 0
    let inString = false
    let escapeNext = false

    for (let j = foundLine; j >= 0; j--) {
      const line = lines[j]

      // Simple approach: look for a line that starts with { or ends with {
      const trimmed = line.trim()
      if (trimmed === '{' || trimmed.endsWith('{')) {
        // Check if this is the outermost brace for this object
        // by verifying we haven't seen any closing braces before this
        return j
      }

      // Also check for array element start
      if (trimmed.startsWith('{')) {
        return j
      }
    }

    // If we didn't find an opening brace, return the line where we found the ID
    return foundLine
  } catch (error) {
    console.error(`Error finding entity line in file ${filePath}:`, error)
  }

  return 0 // Default to first line
}

/**
 * DocumentLinkProvider for GTS IDs
 * Makes GTS IDs clickable and provides hover information
 */
export class GtsLinkProvider implements vscode.DocumentLinkProvider, vscode.HoverProvider {
  private diagnosticCollection: vscode.DiagnosticCollection

  /**
   * The registry is the shared, persistent, index-only registry maintained in
   * registryStore. We never build our own here — decorations/links/hovers just
   * read the current shared state, which is kept fresh by the extension.
   */
  private get registry(): JsonRegistry | null {
    return getRegistry()
  }

  // Decoration types for color coding
  private schemaDecorationType: vscode.TextEditorDecorationType
  private instanceDecorationType: vscode.TextEditorDecorationType
  private errorDecorationType: vscode.TextEditorDecorationType

  constructor(diagnosticCollection: vscode.DiagnosticCollection) {
    this.diagnosticCollection = diagnosticCollection

    const schemaBackgroundColor = 'background-color: ' + GTS_COLORS.schema.background_transparent
    const instanceBackgroundColor = 'background-color: ' + GTS_COLORS.instance.background_transparent

    // Create decoration types with colors from shared constants
    this.schemaDecorationType = vscode.window.createTextEditorDecorationType({
      color: GTS_COLORS.schema.foreground,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      // No outer spacing on the left segment; keep the string start aligned.
      before: { contentText: '', margin: '0 0 0 0' },
      after:  { contentText: '', margin: '0 0 0 0' },
      textDecoration: [
        'none',
        'border: 1px solid ' + GTS_COLORS.schema.background_transparent,
        'background-color: ' + GTS_COLORS.schema.background_transparent,
        'border-radius: 4px',
      ].join('; ')
    })

    this.instanceDecorationType = vscode.window.createTextEditorDecorationType({
      color: GTS_COLORS.instance.foreground,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      // Keep the only spacing between segments (after `~`, before instance part).
      before: { contentText: '', margin: '0 0 0 0.1em' },
      after:  { contentText: '', margin: '0 0 0 0' },
      textDecoration: [
        'none',
        'border: 1px solid ' + GTS_COLORS.instance.background_transparent,
        'background-color: ' + GTS_COLORS.instance.background_transparent,
        'border-radius: 4px',       // ← side margins around the span
      ].join('; ')
    })

    this.errorDecorationType = vscode.window.createTextEditorDecorationType({
      color: GTS_COLORS.invalid.foreground,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: { contentText: '', margin: '0 0 0 0' },
      after:  { contentText: '', margin: '0 0 0 0' },
      textDecoration: [
        'none',
        'border: 1px solid ' + GTS_COLORS.invalid.background_transparent,
        'background-color: ' + GTS_COLORS.invalid.background_transparent,
        'border-radius: 4px',    // ← side margins around the span
      ].join('; ')
    })

    // Registry is provided by the shared store; paint whatever is already available.
    this.updateDecorationsForAllEditors()
  }

  /**
   * Dispose of decoration types and clear diagnostics
   */
  dispose(): void {
    this.schemaDecorationType.dispose()
    this.instanceDecorationType.dispose()
    this.errorDecorationType.dispose()
    this.diagnosticCollection.clear()
  }

  /**
   * Repaint decorations from the current shared registry.
   *
   * The shared registry is kept up to date by the extension (full scans and
   * incremental per-file updates), so refreshing here is just a repaint — no
   * parsing or validation happens on this path.
   */
  public async refresh(): Promise<void> {
    this.updateDecorationsForAllEditors()
  }

  /**
   * Update decorations for all visible editors
   */
  private updateDecorationsForAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateDecorations(editor)
    }
  }

  /**
   * Update decorations for a specific editor
   */
  public updateDecorations(editor: vscode.TextEditor): void {
    if (!this.registry) {
      return
    }

    const document = editor.document

    // Only decorate JSON/JSONC/GTS files
    if (!['json', 'jsonc', 'gts'].includes(document.languageId)) {
      return
    }

    const schemaRanges: vscode.Range[] = []
    const instanceRanges: vscode.Range[] = []
    const errorRanges: vscode.Range[] = []
    const diagnostics: vscode.Diagnostic[] = []

    // Find all GTS references
    const references = this.findGtsReferences(document)

    for (const ref of references) {
      // Malformed gts:// prefix usage (required in JSON Schema URL fields, forbidden
      // elsewhere). Highlight the whole value in red; the authoritative diagnostic is
      // published by the shared validator (validation.ts) to avoid duplicate markers.
      if (ref.urlPrefixIssue) {
        const text = document.getText()
        const refOffset = document.offsetAt(ref.range.start)
        let gtsStartOffset = refOffset
        if (text[refOffset] === '"') {
          gtsStartOffset = refOffset + 1
        }
        const startPos = document.positionAt(gtsStartOffset)
        const endPos = document.positionAt(gtsStartOffset + ref.rawValue.length)
        errorRanges.push(new vscode.Range(startPos, endPos))
        continue
      }

      // Check if the GTS ID is valid according to GTS_REGEX
      if (!ref.isValid) {
        // Invalid GTS format - mark the entire string as error
        const text = document.getText()
        const refOffset = document.offsetAt(ref.range.start)
        let gtsStartOffset = refOffset
        if (text[refOffset] === '"') {
          gtsStartOffset = refOffset + 1
        }
        const startPos = document.positionAt(gtsStartOffset)
        const endPos = document.positionAt(gtsStartOffset + ref.rawValue.length)
        const errorRange = new vscode.Range(startPos, endPos)
        errorRanges.push(errorRange)

        // Create diagnostic for invalid GTS format
        const diagnostic = new vscode.Diagnostic(
          errorRange,
          `Invalid GTS ID format: "${ref.rawValue}". Expected pattern: gts.<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>[.<MIN>[~...]]`,
          vscode.DiagnosticSeverity.Error
        )
        diagnostic.source = 'gts'
        diagnostics.push(diagnostic)

        continue
      }

      // Parse the GTS ID into parts
      const parts = parseGtsIdParts(ref.id)

      // Calculate the offset of the string value (excluding quotes)
      const text = document.getText()
      const refOffset = document.offsetAt(ref.range.start)

      // Find the actual start of the GTS ID (after the opening quote and any
      // gts:// URI prefix, so the highlighted segments align with the canonical id).
      let gtsStartOffset = refOffset
      if (text[refOffset] === '"') {
        gtsStartOffset = refOffset + 1
      }
      gtsStartOffset += ref.uriPrefixLength

      let currentOffset = gtsStartOffset
      for (const part of parts) {
        const partStartPos = document.positionAt(currentOffset)
        const partEndPos = document.positionAt(currentOffset + part.length)
        const partRange = new vscode.Range(partStartPos, partEndPos)

        // Determine the full entity ID to look up
        let entityIdToLookup: string
        if (parts.length === 1) {
          entityIdToLookup = part
        } else if (part === parts[0]) {
          entityIdToLookup = part
        } else {
          entityIdToLookup = parts[0] + part
        }

        // Look up the entity in the registry
        const entity = this.registry.jsonSchemas.get(entityIdToLookup) || this.registry.jsonObjs.get(entityIdToLookup)

        if (entity) {
          if (entity.isSchema) {
            schemaRanges.push(partRange)
          } else {
            instanceRanges.push(partRange)
          }
        } else {
          // Entity not found - mark as error
          errorRanges.push(partRange)

          // Create diagnostic for missing entity
          const diagnostic = new vscode.Diagnostic(
            partRange,
            `GTS entity not found: "${entityIdToLookup}"`,
            vscode.DiagnosticSeverity.Error
          )
          diagnostic.source = 'gts'
          diagnostics.push(diagnostic)
        }

        currentOffset += part.length
      }
    }

    // Apply decorations
    editor.setDecorations(this.schemaDecorationType, schemaRanges)
    editor.setDecorations(this.instanceDecorationType, instanceRanges)
    editor.setDecorations(this.errorDecorationType, errorRanges)

    // Update diagnostics for this document
    this.diagnosticCollection.set(document.uri, diagnostics)
  }

  /**
   * Find all GTS ID references in the document using jsonc-parser
   */
  private findGtsReferences(document: vscode.TextDocument): GtsIdReference[] {
    const references: GtsIdReference[] = []
    const text = document.getText()

    try {
      // Parse the document to get the AST
      const parseErrors: jsonc.ParseError[] = []
      const root = jsonc.parseTree(text, parseErrors, { allowTrailingComma: true })

      if (!root) {
        return references
      }

      // Visit all nodes in the tree
      jsonc.visit(text, {
        onLiteralValue: (value: any, offset: number, length: number, startLine: number, startCharacter: number) => {
          // Consider strings written in canonical form ("gts.") as well as JSON
          // Schema URI form ("gts://"). Both are surfaced so we can flag misuse of
          // the gts:// prefix in either direction.
          if (typeof value === 'string' && (value.startsWith('gts.') || value.startsWith(GTS_URI_PREFIX))) {
            const startPos = document.positionAt(offset)
            const endPos = document.positionAt(offset + length)
            const range = new vscode.Range(startPos, endPos)

            // Get the property path for this value
            const node = jsonc.findNodeAtOffset(root, offset)
            const path = jsonc.getNodePath(node?.parent || node || root)
            const sourcePath = path.join('.')

            // Determine the leaf field name this value is assigned to. The value
            // node's own path ends with its property key (or an array index).
            const valuePath = jsonc.getNodePath(node || root)
            let fieldName = ''
            for (let i = valuePath.length - 1; i >= 0; i--) {
              if (typeof valuePath[i] === 'string') {
                fieldName = valuePath[i] as string
                break
              }
            }

            const rawValue = value
            const id = normalizeGtsId(rawValue)
            const uriPrefixLength = rawValue.startsWith(GTS_URI_PREFIX) ? GTS_URI_PREFIX.length : 0
            const isValid = GTS_REGEX.test(id)
            const urlPrefixIssue = checkGtsUriPrefix(fieldName, rawValue)

            references.push({
              id,
              rawValue,
              uriPrefixLength,
              fieldName,
              range,
              sourcePath,
              isValid,
              urlPrefixIssue
            })
          }
        }
      })
    } catch (error) {
      console.error('[GTS LinkProvider] Error parsing document:', error)
    }

    return references
  }

  /**
   * Provide document links for GTS IDs
   */
  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentLink[]> {
    if (!this.registry) {
      return []
    }

    const links: vscode.DocumentLink[] = []

    // Find all GTS ID references using the parser
    const references = this.findGtsReferences(document)

    for (const ref of references) {
      // Don't link malformed or prefix-violating values.
      if (ref.urlPrefixIssue || !ref.isValid) {
        continue
      }

      // Parse the GTS ID into parts
      const parts = parseGtsIdParts(ref.id)

      // Calculate the offset of the string value (excluding quotes)
      const text = document.getText()
      const refOffset = document.offsetAt(ref.range.start)

      // Find the actual start of the GTS ID (after the opening quote and any
      // gts:// URI prefix).
      let gtsStartOffset = refOffset
      if (text[refOffset] === '"') {
        gtsStartOffset = refOffset + 1
      }
      gtsStartOffset += ref.uriPrefixLength

      let currentOffset = gtsStartOffset
      for (const part of parts) {
        const partStartPos = document.positionAt(currentOffset)
        const partEndPos = document.positionAt(currentOffset + part.length)
        const partRange = new vscode.Range(partStartPos, partEndPos)

        // Determine the full entity ID to look up
        let entityIdToLookup: string
        if (parts.length === 1) {
          // Only one part, use it as-is
          entityIdToLookup = part
        } else if (part === parts[0]) {
          // First part (schema type)
          entityIdToLookup = part
        } else {
          // Second part (instance), combine with first part
          entityIdToLookup = parts[0] + part
        }

        // Look up the entity in the registry
        const entity = this.registry.jsonSchemas.get(entityIdToLookup) || this.registry.jsonObjs.get(entityIdToLookup)

        if (entity && entity.file) {
          // Create a document link
          const link = new vscode.DocumentLink(partRange)

          // Find the line number where the entity is defined
          const lineNumber = findEntityLineInFile(entity.file.path, entityIdToLookup)

          // Create a command URI that opens the file at the specific line
          const uri = vscode.Uri.parse(
            `command:vscode.open?${encodeURIComponent(JSON.stringify([
              vscode.Uri.file(entity.file.path),
              { selection: new vscode.Range(lineNumber, 0, lineNumber, 0) }
            ]))}`
          )

          link.target = uri
          // Don't set tooltip - we provide rich hover via HoverProvider instead

          links.push(link)
        }

        currentOffset += part.length
      }
    }

    return links
  }

  /**
   * Provide hover information for GTS IDs
   */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (!this.registry) {
      return null
    }

    // Find all GTS references in the document
    const references = this.findGtsReferences(document)

    // Find the reference that contains the cursor position
    let matchedRef: GtsIdReference | null = null
    for (const ref of references) {
      if (ref.range.contains(position)) {
        matchedRef = ref
        break
      }
    }

    if (!matchedRef) {
      return null
    }

    const gtsId = matchedRef.id

    // Calculate the offset within the string value (excluding quotes)
    const text = document.getText()
    const refOffset = document.offsetAt(matchedRef.range.start)
    let gtsStartOffset = refOffset
    if (text[refOffset] === '"') {
      gtsStartOffset = refOffset + 1
    }

    // Create hover content
    const markdown = new vscode.MarkdownString()
    markdown.isTrusted = true
    markdown.supportHtml = false

    // Malformed gts:// prefix usage - explain the rule and offer a one-click fix.
    if (matchedRef.urlPrefixIssue) {
      const startPos = document.positionAt(gtsStartOffset)
      const endPos = document.positionAt(gtsStartOffset + matchedRef.rawValue.length)
      const hoverRange = new vscode.Range(startPos, endPos)

      markdown.appendMarkdown(`⚠️ Malformed GTS identifier\n\n`)
      markdown.appendMarkdown(`${escapeMarkdown(matchedRef.urlPrefixIssue.message)}\n\n`)

      const rangeData = {
        start: { line: hoverRange.start.line, character: hoverRange.start.character },
        end: { line: hoverRange.end.line, character: hoverRange.end.character }
      }
      const commandUri = vscode.Uri.parse(
        `command:gts.replaceGtsId?${encodeURIComponent(JSON.stringify([
          document.uri.toString(),
          rangeData,
          matchedRef.urlPrefixIssue.suggestion,
          false  // includeQuotes - range already excludes quotes
        ]))}`
      )
      markdown.appendMarkdown(`**Fix:** (click to replace)\n\n`)
      markdown.appendMarkdown(`- [${escapeMarkdown(matchedRef.urlPrefixIssue.suggestion)}](${commandUri.toString()})\n`)

      return new vscode.Hover(markdown, hoverRange)
    }

    // Check if the GTS ID is invalid
    if (!matchedRef.isValid) {
      // Invalid GTS format - show error with suggestions
      const startPos = document.positionAt(gtsStartOffset)
      const endPos = document.positionAt(gtsStartOffset + matchedRef.rawValue.length)
      const hoverRange = new vscode.Range(startPos, endPos)

      markdown.appendMarkdown(`⚠️ Invalid GTS ID Format!\n\n`)
      markdown.appendMarkdown(`ID: ${escapeMarkdown(gtsId)}\n\n`)
      markdown.appendMarkdown(`This string starts with "gts." but doesn't match the valid GTS ID pattern.\n\n`)
      markdown.appendMarkdown(`Expected GTS pattern is:\n\n${escapeMarkdown('gts.<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>[.<MIN>[~[<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>[.<MIN>...]...]]]')}\n\n`)

      /*
      markdown.appendMarkdown(`Where:\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <VENDOR>: Vendor name')}\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <PACKAGE>: Package name')}\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <NAMESPACE>: Namespace name')}\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <TYPE>: Type or instance name')}\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <MAJOR>: Major version')}\n`)
      markdown.appendMarkdown(`${escapeMarkdown('- <MINOR>: Minor version')}\n\n`)
      */

      // Get all entity IDs from registry
      const allEntityIds = [
        ...Array.from(this.registry.jsonSchemas.keys()),
        ...Array.from(this.registry.jsonObjs.keys())
      ].filter(id => GTS_REGEX.test(id)) // Only suggest valid GTS IDs

      // Find similar entities
      const suggestions = findSimilarEntityIds(gtsId, allEntityIds, 3)

      if (suggestions.length > 0) {
        markdown.appendMarkdown(`**Did you mean:** (click to replace)\n\n`)
        for (const suggestion of suggestions) {
          const suggestionEntity = this.registry.jsonSchemas.get(suggestion) || this.registry.jsonObjs.get(suggestion)
          if (suggestionEntity) {
            const entityType = suggestionEntity.isSchema ? '📘 Schema' : '📄 Instance'
            // Create command URI to replace the erroneous GTS ID
            // Serialize range as plain object
            const rangeData = {
              start: { line: hoverRange.start.line, character: hoverRange.start.character },
              end: { line: hoverRange.end.line, character: hoverRange.end.character }
            }
            const commandUri = vscode.Uri.parse(
              `command:gts.replaceGtsId?${encodeURIComponent(JSON.stringify([
                document.uri.toString(),
                rangeData,
                suggestion,
                false  // includeQuotes - range already excludes quotes
              ]))}`
            )
            markdown.appendMarkdown(`- ${entityType}: [${escapeMarkdown(suggestion)}](${commandUri.toString()})\n`)
          }
        }
      } else {
        markdown.appendMarkdown(`*No similar entities found in the registry.*`)
      }

      return new vscode.Hover(markdown, hoverRange)
    }

    // Parse the GTS ID to determine which part we're hovering over. The canonical
    // parts start after the quote and any gts:// URI prefix.
    const parts = parseGtsIdParts(gtsId)
    const gtsBodyOffset = gtsStartOffset + matchedRef.uriPrefixLength

    // Determine which part the cursor is on
    const cursorOffset = document.offsetAt(position)
    const relativeOffset = cursorOffset - gtsBodyOffset

    let entityIdToLookup = gtsId
    let hoverRange = matchedRef.range

    if (parts.length > 1) {
      const firstPartLength = parts[0].length
      if (relativeOffset < firstPartLength) {
        // Cursor is on the first part
        entityIdToLookup = parts[0]
        const startPos = document.positionAt(gtsBodyOffset)
        const endPos = document.positionAt(gtsBodyOffset + firstPartLength)
        hoverRange = new vscode.Range(startPos, endPos)
      } else {
        // Cursor is on the second part
        entityIdToLookup = parts[0] + parts[1]
        const startPos = document.positionAt(gtsBodyOffset + firstPartLength)
        const endPos = document.positionAt(gtsBodyOffset + gtsId.length)
        hoverRange = new vscode.Range(startPos, endPos)
      }
    }

    // Look up the entity in the registry
    const entity = this.registry.jsonSchemas.get(entityIdToLookup) || this.registry.jsonObjs.get(entityIdToLookup)

    if (!entity) {
      // Entity not found - show error with suggestions
      markdown.appendMarkdown(`⚠️ GTS Entity Not Found!\n\n`)
      markdown.appendMarkdown(`ID: ${escapeMarkdown(entityIdToLookup)}\n\n`)

      // Get all entity IDs from registry
      const allEntityIds = [
        ...Array.from(this.registry.jsonSchemas.keys()),
        ...Array.from(this.registry.jsonObjs.keys())
      ].filter(id => GTS_REGEX.test(id)) // Only suggest valid GTS IDs

      // Find similar entities
      const suggestions = findSimilarEntityIds(entityIdToLookup, allEntityIds, 3)

      if (suggestions.length > 0) {
        markdown.appendMarkdown(`**Did you mean:** (click to replace)\n\n`)
        for (const suggestion of suggestions) {
          const suggestionEntity = this.registry.jsonSchemas.get(suggestion) || this.registry.jsonObjs.get(suggestion)
          if (suggestionEntity) {
            const entityType = suggestionEntity.isSchema ? '📘 Schema' : '📄 Instance'
            // Create command URI to replace the erroneous GTS ID
            // Serialize range as plain object
            const rangeData = {
              start: { line: hoverRange.start.line, character: hoverRange.start.character },
              end: { line: hoverRange.end.line, character: hoverRange.end.character }
            }
            const commandUri = vscode.Uri.parse(
              `command:gts.replaceGtsId?${encodeURIComponent(JSON.stringify([
                document.uri.toString(),
                rangeData,
                suggestion,
                false  // includeQuotes - range already excludes quotes
              ]))}`
            )
            markdown.appendMarkdown(`- ${entityType}: [${escapeMarkdown(suggestion)}](${commandUri.toString()})\n`)
          }
        }
      } else {
        markdown.appendMarkdown(`*No similar entities found in the registry.*`)
      }

      return new vscode.Hover(markdown, hoverRange)
    }

    if (!entity.file) {
      return null
    }

    // Determine entity type
    const entityType = entity.isSchema ? 'Schema' : 'Instance'

    // Add file path as a clickable link
    const lineNumber = findEntityLineInFile(entity.file.path, entityIdToLookup)
    const fileUri = vscode.Uri.file(entity.file.path).with({
      fragment: `L${lineNumber + 1}`
    })
    const relativePath = getRelativePath(entity.file.path)

    // Make the GTS ID itself clickable
    markdown.appendMarkdown(`GTS ID: [${escapeMarkdown(entityIdToLookup)}](${fileUri.toString()})\n\n`)
    markdown.appendMarkdown(`Type: ${entityType}\n\n`)
    markdown.appendMarkdown(`Definition: [${escapeMarkdown(relativePath)}](${fileUri.toString()})`)

    // Add description if available (on a new line, no label)
    const description = entity.description || ''
    if (description && description !== entityIdToLookup) {
      markdown.appendMarkdown(`\n\nDescription: ${escapeMarkdown(description)}`)
    }

    return new vscode.Hover(markdown, hoverRange)
  }
}
