import * as vscode from 'vscode'
import { JsonRegistry, GTS_COLORS, GTS_URI_PREFIX, parseGtsIdParts, analyzeGtsIdForStyling, findSimilarEntityIds, normalizeGtsId, checkGtsUriPrefix, isGtsId, isGtsIdOrPattern, isGtsPattern, isYamlFileName } from '@gts/shared'
import type { GtsPrefixIssue, JsonEntity } from '@gts/shared'
import * as fs from 'fs'
import { getRegistry, getRegistryRevision } from './registryStore'
import { getDocumentValidationErrors } from './validation'
import * as jsonc from 'jsonc-parser'
import * as YAML from 'yaml'

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
  /** Offset of the value's first character (after any opening quote). */
  contentOffset: number
  sourcePath: string
  isValid: boolean // Whether the ID is a valid GTS identifier or pattern
  /** Whether the value is a valid GTS wildcard pattern (e.g. "gts.*"). */
  isPattern: boolean
  /** gts:// prefix problem for this value's field, if any. */
  urlPrefixIssue: GtsPrefixIssue | null
}

/**
 * Escape text taken from workspace files (ids, descriptions, error messages) so
 * it renders literally in hover markdown. Every ASCII punctuation character that
 * CommonMark lets you backslash-escape is escaped — including the backslash
 * itself: escaping only `[`/`]` lets `\[x\](command:...)` collapse back into a
 * live link, which in a command-enabled hover runs a VS Code command on click.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()<>#+\-.!|~"'&:=]/g, '\\$&')
}

/** Render text as an inline code span (backslash escapes don't apply inside one). */
function codeSpan(text: string): string {
  return '`' + text.replace(/`/g, "'") + '`'
}

/**
 * Hovers may only run this extension's own replace command (used by the "Did
 * you mean" / "Fix" links). Never `isTrusted = true`, which enables every
 * command for any link that ends up in the markdown.
 */
const HOVER_TRUST = { enabledCommands: ['gts.replaceGtsId'] }

/**
 * Workspace-relative path for display. In a multi-root workspace this is
 * prefixed with the owning folder's name; outside every folder it stays absolute.
 */
function getRelativePath(absolutePath: string): string {
  return vscode.workspace.asRelativePath(absolutePath)
}

// Definition-line lookups, valid for one registry revision (any re-index
// invalidates them, since the defining file may have changed).
let definitionLineCache = { revision: -1, lines: new Map<string, number>() }

/**
 * Zero-based line on which `entity` is defined: the line of its id field (or,
 * failing that, of its list item). Reads the live buffer when the file is open,
 * otherwise the file on disk (asynchronously), and caches the result. This used
 * to be a synchronous disk read + line scan for every segment of every link on
 * every link request, and matched the first line merely *containing* the id.
 */
async function findDefinitionLine(entity: JsonEntity): Promise<number> {
  const filePath = entity.file?.path
  if (!filePath) return 0
  const revision = getRegistryRevision()
  if (definitionLineCache.revision !== revision) definitionLineCache = { revision, lines: new Map() }
  const key = `${filePath}\0${entity.id}\0${entity.listSequence ?? ''}`
  const cached = definitionLineCache.lines.get(key)
  if (cached !== undefined) return cached

  let line = 0
  try {
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath)
    const text = openDoc ? openDoc.getText() : await fs.promises.readFile(filePath, 'utf8')
    line = lineOfOffset(text, locateDefinitionOffset(text, filePath, entity))
  } catch (error) {
    console.error(`[GTS] Could not locate ${entity.id} in ${filePath}:`, error)
  }
  if (definitionLineCache.revision === revision) definitionLineCache.lines.set(key, line)
  return line
}

/** Offset of the entity's id field value (or its list item) in the file's text. */
function locateDefinitionOffset(text: string, filePath: string, entity: JsonEntity): number {
  const seq = entity.listSequence
  const idField = entity.selectedEntityIdField || entity.selectedSchemaIdField
  const itemPath: Array<string | number> = seq !== undefined ? [seq] : []
  const idPath = idField ? [...itemPath, idField] : itemPath

  let offset: number | undefined
  if (isYamlFileName(filePath)) {
    const doc = YAML.parseDocument(text)
    const rangeStart = (path: Array<string | number>) => {
      const node = path.length > 0 ? doc.getIn(path, true) : doc.contents
      return (node as { range?: [number, number, number] } | null | undefined)?.range?.[0]
    }
    offset = rangeStart(idPath) ?? (itemPath.length > 0 ? rangeStart(itemPath) : undefined)
  } else {
    const root = jsonc.parseTree(text, undefined, { allowTrailingComma: true })
    if (root) {
      offset = (idPath.length > 0 ? jsonc.findNodeAtLocation(root, idPath)?.offset : undefined)
        ?? (itemPath.length > 0 ? jsonc.findNodeAtLocation(root, itemPath)?.offset : undefined)
    }
  }
  // Last resort (e.g. YAML entities defined inline deep in a config file).
  if (offset === undefined) {
    const idx = text.indexOf(entity.id)
    offset = idx >= 0 ? idx : 0
  }
  return offset
}

function lineOfOffset(text: string, offset: number): number {
  let line = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** A link to an entity's definition; its target is computed only when the link is used. */
class GtsDefinitionLink extends vscode.DocumentLink {
  constructor(range: vscode.Range, readonly entityId: string) {
    super(range)
  }
}

/**
 * DocumentLinkProvider for GTS IDs
 * Makes GTS IDs clickable and provides hover information
 */
export class GtsLinkProvider implements vscode.DocumentLinkProvider<vscode.DocumentLink>, vscode.HoverProvider {
  // Parsed GTS references per open document version. Decorations, links and
  // every hover over the same unchanged document reuse one parse.
  private referenceCache = new WeakMap<vscode.TextDocument, { version: number; references: GtsIdReference[] }>()

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
  private unresolvedDecorationType: vscode.TextEditorDecorationType
  // Position-based gap inserted before every non-first GTS segment so the
  // spacing between `~`-separated segments is identical regardless of the
  // colour/style (schema/instance/error) of the following segment.
  private segmentGapDecorationType: vscode.TextEditorDecorationType

  constructor() {
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
      // Inter-segment spacing is handled uniformly by segmentGapDecorationType,
      // so the chip itself carries no outer margin (keeps gaps style-independent).
      before: { contentText: '', margin: '0 0 0 0' },
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

    // Valid GTS format but entity not found in project (e.g. in "examples")
    this.unresolvedDecorationType = vscode.window.createTextEditorDecorationType({
      color: GTS_COLORS.unresolved.foreground,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: { contentText: '', margin: '0 0 0 0' },
      after:  { contentText: '', margin: '0 0 0 0' },
      textDecoration: [
        'none',
        'border: 1px solid ' + GTS_COLORS.unresolved.background_transparent,
        'background-color: ' + GTS_COLORS.unresolved.background_transparent,
        'border-radius: 4px',
      ].join('; ')
    })

    // Colourless spacer applied to every non-first segment. It inserts a fixed
    // left margin before the segment's chip so the gap after each `~` is the
    // same width whether the following segment is a schema, instance, or error.
    this.segmentGapDecorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: { contentText: '', margin: '0 0 0 0.1em' },
    })

    // Registry is provided by the shared store; paint whatever is already available.
    this.updateDecorationsForAllEditors()
  }

  /**
   * Dispose of decoration types
   */
  dispose(): void {
    this.schemaDecorationType.dispose()
    this.instanceDecorationType.dispose()
    this.errorDecorationType.dispose()
    this.unresolvedDecorationType.dispose()
    this.segmentGapDecorationType.dispose()
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
   * Update decorations for visible editors showing the given document URI.
   */
  public updateDecorationsForUri(uri: vscode.Uri): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.updateDecorations(editor)
      }
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
    const filePath = document.uri.fsPath

    // Only decorate JSON/JSONC/GTS/YAML files
    if (!['json', 'jsonc', 'gts', 'yaml'].includes(document.languageId) && !isYamlFileName(document.fileName)) {
      return
    }

    const docErrors = [
      ...getDocumentValidationErrors(document.uri),
      ...(this.registry.jsonFileSchemas.get(filePath) || []).flatMap(e => e.validation?.errors || []),
      ...(this.registry.jsonFileObjs.get(filePath) || []).flatMap(e => e.validation?.errors || []),
      ...(this.registry.invalidFiles.get(filePath)?.validation?.errors || [])
    ]

    const schemaRanges: vscode.Range[] = []
    const instanceRanges: vscode.Range[] = []
    const errorRanges: vscode.Range[] = []
    const unresolvedRanges: vscode.Range[] = []
    const gapRanges: vscode.Range[] = []

    // Find all GTS references
    const references = this.findGtsReferences(document)

    for (const ref of references) {
      // Malformed gts:// prefix usage (required in JSON Schema URL fields, forbidden
      // elsewhere). Highlight the whole value in red; the authoritative diagnostic is
      // published by the shared validator (validation.ts) to avoid duplicate markers.
      if (ref.urlPrefixIssue) {
        const gtsStartOffset = ref.contentOffset
        const startPos = document.positionAt(gtsStartOffset)
        const endPos = document.positionAt(gtsStartOffset + ref.rawValue.length)
        errorRanges.push(new vscode.Range(startPos, endPos))
        continue
      }

      // Malformed GTS id: red chip only. The diagnostic itself is published by
      // the validator (validation.ts, keyword 'gts-id-format') for open and
      // closed files alike, so the file's status doesn't depend on whether it
      // happens to be open.
      if (!ref.isValid) {
        const gtsStartOffset = ref.contentOffset
        const startPos = document.positionAt(gtsStartOffset)
        const endPos = document.positionAt(gtsStartOffset + ref.rawValue.length)
        errorRanges.push(new vscode.Range(startPos, endPos))
        continue
      }

      // Wildcard patterns (e.g. "gts.*" in x-gts-ref) are valid GTS references
      // but don't resolve to specific entities — show as schema decoration
      if (ref.isPattern) {
        const gtsStartOffset = ref.contentOffset + ref.uriPrefixLength
        const startPos = document.positionAt(gtsStartOffset)
        const endPos = document.positionAt(gtsStartOffset + ref.id.length)
        schemaRanges.push(new vscode.Range(startPos, endPos))
        continue
      }

      // Classify the segments using the shared, core-backed styling analyzer so
      // schema-vs-instance is derived STRUCTURALLY from the GTS ID via gts-ts.
      // Correctness (red vs blue/green) comes from the authoritative gts-ts
      // validation results: a *schema* segment whose entity failed gts-ts
      // validation (e.g. an invalid derived schema in the chain) is `isValid:
      // false` → red. Instance-level, field-specific errors (abstract type,
      // x-gts-ref, ...) are handled by `hasFieldError` below, not by flagging the
      // whole instance entity, so an instance's own id is not reddened merely
      // because some other field of it failed. No GTS rules are re-derived here.
      const registry = this.registry
      const analysis = analyzeGtsIdForStyling(ref.id, (entityId: string) => {
        const schema = registry.jsonSchemas.get(entityId)
        if (schema) {
          return { exists: true, isSchema: true, isValid: !schema.validation?.errors?.length }
        }
        const obj = registry.jsonObjs.get(entityId)
        if (obj) {
          return { exists: true, isSchema: false }
        }
        return { exists: false }
      })

      // A gts-ts validation error reported at (or under) this field's instance
      // path means the value written here is what's wrong — colour every segment
      // red regardless of its structural classification.
      const refInstancePath = '/' + ref.sourcePath.replace(/\./g, '/').replace(/\[(\d+)\]/g, '/$1')
      const hasFieldError = docErrors.some(err => {
        return Boolean(err.instancePath && (err.instancePath === refInstancePath || err.instancePath.startsWith(refInstancePath + '/')))
      })

      // Calculate the offset of the string value (excluding quotes)
      const gtsStartOffset = ref.contentOffset + ref.uriPrefixLength

      // References inside an "examples" field show missing entities as a neutral
      // gray chip instead of a red error.
      const inExamples = ref.sourcePath.split('.').some(seg => seg === 'examples')

      for (let segIndex = 0; segIndex < analysis.segments.length; segIndex++) {
        const seg = analysis.segments[segIndex]
        const partStartPos = document.positionAt(gtsStartOffset + seg.startOffset)
        const partEndPos = document.positionAt(gtsStartOffset + seg.endOffset)
        const partRange = new vscode.Range(partStartPos, partEndPos)

        // Every segment after the first gets a uniform leading gap, so the
        // spacing between `~`-separated segments does not depend on the
        // following segment's colour/style (schema/instance/error).
        if (segIndex > 0) {
          gapRanges.push(partRange)
        }

        if (hasFieldError) {
          errorRanges.push(partRange)
        } else if (seg.type === 'schema') {
          schemaRanges.push(partRange)
        } else if (seg.type === 'instance') {
          instanceRanges.push(partRange)
        } else if (inExamples) {
          // Entity not found inside an examples block — neutral gray chip.
          unresolvedRanges.push(partRange)
        } else {
          // Red chip only — the authoritative "GTS reference not found"
          // diagnostic for this is published by the shared validator
          // (registry.validateEntity, surfaced via validation.ts) so we
          // don't publish a second, duplicate diagnostic for the same miss.
          errorRanges.push(partRange)
        }
      }
    }

    // Apply decorations
    editor.setDecorations(this.schemaDecorationType, schemaRanges)
    editor.setDecorations(this.instanceDecorationType, instanceRanges)
    editor.setDecorations(this.errorDecorationType, errorRanges)
    editor.setDecorations(this.unresolvedDecorationType, unresolvedRanges)
    editor.setDecorations(this.segmentGapDecorationType, gapRanges)
  }

  /**
   * Find all GTS ID references in the document, using the parser appropriate
   * for its format (YAML vs JSON/JSONC), so YAML files get exactly the same
   * blue/red/gray annotations, hovers and links as JSON files do.
   */
  private findGtsReferences(document: vscode.TextDocument): GtsIdReference[] {
    const cached = this.referenceCache.get(document)
    if (cached && cached.version === document.version) return cached.references
    const references = document.languageId === 'yaml' || isYamlFileName(document.fileName)
      ? this.findGtsReferencesYaml(document)
      : this.findGtsReferencesJson(document)
    this.referenceCache.set(document, { version: document.version, references })
    return references
  }

  /**
   * Build a GtsIdReference from a raw string value found at a known document
   * offset range. Shared by both the JSON and YAML reference finders.
   */
  private buildGtsIdReference(rawValue: string, fieldName: string, sourcePath: string, range: vscode.Range, contentOffset: number): GtsIdReference {
    const id = normalizeGtsId(rawValue)
    const uriPrefixLength = rawValue.startsWith(GTS_URI_PREFIX) ? GTS_URI_PREFIX.length : 0
    const isValid = isGtsId(id)
    // Also accept wildcard patterns (e.g. "gts.*") using gts-ts validation
    const isWildcardPattern = !isValid && isGtsPattern(id)
    const urlPrefixIssue = checkGtsUriPrefix(fieldName, rawValue)

    return {
      id,
      rawValue,
      uriPrefixLength,
      fieldName,
      range,
      contentOffset,
      sourcePath,
      isValid: isValid || isWildcardPattern,
      isPattern: isWildcardPattern,
      urlPrefixIssue
    }
  }

  /**
   * Find all GTS ID references in a YAML document.
   *
   * YAML has no widely-used equivalent of jsonc-parser's offset-tracking
   * visitor for JSON, so we use the `yaml` package's CST, which records a
   * `range` (character offsets into the source text) on every scalar node.
   * `range.start` here is normalized to point at the first character of the
   * actual string content (skipping any opening quote), independent of the
   * quote style used, so downstream consumers that were written for the JSON
   * path (which skip a leading `"` themselves) work unchanged for YAML too.
   */
  private findGtsReferencesYaml(document: vscode.TextDocument): GtsIdReference[] {
    const references: GtsIdReference[] = []
    const text = document.getText()

    let doc: YAML.Document.Parsed
    try {
      doc = YAML.parseDocument(text)
    } catch (error) {
      console.error('[GTS LinkProvider] Error parsing YAML document:', error)
      return references
    }
    if (doc.contents == null) {
      return references
    }

    try {
      YAML.visit(doc, {
        Scalar: (key, node, path) => {
          const value = (node as YAML.Scalar).value
          // Only interested in string values; never the YAML key tokens.
          if (key === 'key' || typeof value !== 'string') return
          if (!(value.startsWith('gts.') || value.startsWith(GTS_URI_PREFIX))) return

          const nodeRange = node.range
          if (!nodeRange) return
          const [startOffset, valueEndOffset] = nodeRange

          // Skip the opening quote (if any) so the range points directly at
          // the string's content, matching what downstream code expects.
          const raw = text.slice(startOffset, valueEndOffset)
          const quoteLen = raw.startsWith('"') || raw.startsWith("'") ? 1 : 0
          const valueStartOffset = startOffset + quoteLen

          const startPos = document.positionAt(valueStartOffset)
          const endPos = document.positionAt(valueStartOffset + value.length)
          const range = new vscode.Range(startPos, endPos)

          // Build the ancestor key path (used only to detect "examples"
          // context, same as the JSON path) from the enclosing Map Pairs.
          const pathKeys: string[] = []
          for (const ancestor of path) {
            if (YAML.isPair(ancestor) && YAML.isScalar(ancestor.key)) {
              pathKeys.push(String((ancestor.key as YAML.Scalar).value))
            }
          }
          const fieldName = pathKeys[pathKeys.length - 1] || ''
          const sourcePath = pathKeys.join('.')

          references.push(this.buildGtsIdReference(value, fieldName, sourcePath, range, valueStartOffset))
        }
      })
    } catch (error) {
      console.error('[GTS LinkProvider] Error visiting YAML document:', error)
    }

    return references
  }

  /**
   * Find all GTS ID references in a JSON/JSONC document using jsonc-parser
   */
  private findGtsReferencesJson(document: vscode.TextDocument): GtsIdReference[] {
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
            const valuePath = jsonc.getNodePath(node || root)
            const sourcePath = valuePath.join('.')

            // Determine the leaf field name this value is assigned to. The value
            // node's own path ends with its property key (or an array index).
            let fieldName = ''
            for (let i = valuePath.length - 1; i >= 0; i--) {
              if (typeof valuePath[i] === 'string') {
                fieldName = valuePath[i] as string
                break
              }
            }

            // String literals are always double-quoted in JSON; content starts after the quote.
            references.push(this.buildGtsIdReference(value, fieldName, sourcePath, range, offset + 1))
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
      // Don't link malformed, prefix-violating, or wildcard pattern values.
      if (ref.urlPrefixIssue || !ref.isValid || ref.isPattern) {
        continue
      }

      // Parse the GTS ID into parts
      const parts = parseGtsIdParts(ref.id)

      // Calculate the offset of the string value (excluding quotes)
      const gtsStartOffset = ref.contentOffset + ref.uriPrefixLength

      let currentOffset = gtsStartOffset
      let hasMissingAncestor = false
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex]
        const partStartPos = document.positionAt(currentOffset)
        const partEndPos = document.positionAt(currentOffset + part.length)
        const partRange = new vscode.Range(partStartPos, partEndPos)

        // Determine the full entity ID to look up
        const entityIdToLookup = parts.slice(0, partIndex + 1).join('')

        // Look up the entity in the registry
        const entity = hasMissingAncestor
          ? undefined
          : this.registry.jsonSchemas.get(entityIdToLookup) || this.registry.jsonObjs.get(entityIdToLookup)

        if (entity && entity.file) {
          // The target (which needs the definition line) is filled in by
          // resolveDocumentLink, only for a link that is actually followed.
          // No tooltip: the HoverProvider supplies a rich hover instead.
          links.push(new GtsDefinitionLink(partRange, entityIdToLookup))
        } else if (!entity) {
          hasMissingAncestor = true
        }

        currentOffset += part.length
      }
    }

    return links
  }

  /** Fill in a definition link's target (file + line) when the link is used. */
  async resolveDocumentLink(link: vscode.DocumentLink): Promise<vscode.DocumentLink> {
    if (!(link instanceof GtsDefinitionLink) || !this.registry) return link
    const entity = this.registry.jsonSchemas.get(link.entityId) || this.registry.jsonObjs.get(link.entityId)
    if (!entity?.file) return link
    const lineNumber = await findDefinitionLine(entity)
    link.target = vscode.Uri.parse(
      `command:vscode.open?${encodeURIComponent(JSON.stringify([
        vscode.Uri.file(entity.file.path),
        { selection: new vscode.Range(lineNumber, 0, lineNumber, 0) }
      ]))}`
    )
    return link
  }

  /**
   * Turn a list of candidate suggestion ids into rendered markdown list items,
   * skipping any that don't resolve to a real registry entity. Returning the
   * concrete lines (rather than appending directly) lets callers decide whether
   * to show the "Did you mean" header at all — it must never appear with no
   * suggestions under it.
   */
  private buildSuggestionLines(
    suggestions: string[],
    document: vscode.TextDocument,
    hoverRange: vscode.Range
  ): string[] {
    if (!this.registry) return []
    const lines: string[] = []
    for (const suggestion of suggestions) {
      const suggestionEntity = this.registry.jsonSchemas.get(suggestion) || this.registry.jsonObjs.get(suggestion)
      if (!suggestionEntity) continue
      const entityType = suggestionEntity.isSchema ? '📘 Schema' : '📄 Instance'
      // Serialize range as a plain object for the replace command.
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
      lines.push(`- ${entityType}: [${escapeMarkdown(suggestion)}](${commandUri.toString()})\n`)
    }
    return lines
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
    const gtsStartOffset = matchedRef.contentOffset

    // Create hover content
    const markdown = new vscode.MarkdownString()
    markdown.isTrusted = HOVER_TRUST
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

    // Wildcard patterns (e.g. "gts.*") — show pattern info hover
    if (matchedRef.isPattern) {
      const startPos = document.positionAt(gtsStartOffset)
      const endPos = document.positionAt(gtsStartOffset + matchedRef.rawValue.length)
      const hoverRange = new vscode.Range(startPos, endPos)

      markdown.appendMarkdown(`GTS Wildcard Pattern\n\n`)
      markdown.appendMarkdown(`Pattern: ${escapeMarkdown(gtsId)}\n\n`)
      markdown.appendMarkdown(`This is a valid GTS wildcard pattern used in x\\-gts\\-ref to match any GTS identifier that starts with the specified prefix.`)

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
      markdown.appendMarkdown(`This string looks like a GTS identifier but doesn't match the valid GTS ID pattern.\n\n`)
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
      ].filter(id => isGtsId(id)) // Only suggest valid GTS IDs

      // Find similar entities that actually resolve to a registry entity, so
      // the "Did you mean" header is only shown when there is at least one
      // clickable suggestion to render underneath it.
      const suggestions = findSimilarEntityIds(gtsId, allEntityIds, 3)
      const suggestionLines = this.buildSuggestionLines(suggestions, document, hoverRange)

      if (suggestionLines.length > 0) {
        markdown.appendMarkdown(`**Did you mean:** (click to replace)\n\n`)
        for (const line of suggestionLines) markdown.appendMarkdown(line)
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
    let hoveredSegmentIndex: number | undefined

    let segmentStartOffset = 0
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      const segmentEndOffset = segmentStartOffset + part.length
      if (relativeOffset >= segmentStartOffset && relativeOffset < segmentEndOffset) {
        hoveredSegmentIndex = partIndex
        entityIdToLookup = parts.slice(0, partIndex + 1).join('')
        const startPos = document.positionAt(gtsBodyOffset + segmentStartOffset)
        const endPos = document.positionAt(gtsBodyOffset + segmentEndOffset)
        hoverRange = new vscode.Range(startPos, endPos)
        break
      }
      segmentStartOffset = segmentEndOffset
    }

    // Classify the hovered segment with the SAME analyzer that drives the
    // colouring, so the hover verdict never contradicts the red/blue/green chip
    // and we don't hand-roll a second, divergent notion of "missing".
    const registry = this.registry
    const analysis = analyzeGtsIdForStyling(gtsId, (id: string) => {
      const schema = registry.jsonSchemas.get(id)
      if (schema) return { exists: true, isSchema: true, isValid: !schema.validation?.errors?.length }
      const obj = registry.jsonObjs.get(id)
      if (obj) return { exists: true, isSchema: false }
      return { exists: false }
    })
    const hoveredSeg = hoveredSegmentIndex !== undefined ? analysis.segments[hoveredSegmentIndex] : undefined

    if (hoveredSeg && hoveredSeg.type === 'error') {
      const firstErrorIdx = analysis.segments.findIndex(s => s.type === 'error')
      // An earlier segment is the real cause; this one only cascades from it.
      if (firstErrorIdx !== -1 && hoveredSegmentIndex !== undefined && firstErrorIdx < hoveredSegmentIndex) {
        const culprit = analysis.segments[firstErrorIdx].entityId
        markdown.appendMarkdown(`GTS Parent Type Not Found\n\n`)
        markdown.appendMarkdown(`This segment derives from ${codeSpan(culprit)}, which is not a defined GTS type.`)
        return new vscode.Hover(markdown, hoverRange)
      }
      // This segment itself is the cause. A "~"-terminated id that resolves only
      // to an instance document (or nothing) names a TYPE that is not defined —
      // it is NOT an ancestor/derivation problem.
      const schemaHere = this.registry.jsonSchemas.get(entityIdToLookup)
      const objHere = this.registry.jsonObjs.get(entityIdToLookup)
      if (!schemaHere && objHere) {
        markdown.appendMarkdown(`⚠️ GTS Type Not Found\n\n`)
        markdown.appendMarkdown(`ID: ${escapeMarkdown(entityIdToLookup)}\n\n`)
        markdown.appendMarkdown(`This is a GTS type identifier, but no type (schema) with this id is defined.`)
        return new vscode.Hover(markdown, hoverRange)
      }
      // Not found at all → fall through to the "GTS Entity Not Found" + suggestions block.
    }

    // Look up the entity in the registry. A segment flagged 'error' by the
    // analyzer can mean two different things: the entity is *absent*, or it
    // *exists but failed GTS validation* (e.g. it references another invalid
    // schema). We must not report an existing entity as "not found" — Cmd+Click
    // resolves it via the same registry, so a "not found" hover would directly
    // contradict the working link. Look it up unconditionally and let its
    // *presence* (not its validity) decide between the "not found" block and the
    // found hover; the invalid state is annotated on the found hover below.
    const entity = this.registry.jsonSchemas.get(entityIdToLookup) || this.registry.jsonObjs.get(entityIdToLookup)

    if (!entity) {
      // Entity not found - show error with suggestions
      markdown.appendMarkdown(`⚠️ GTS Entity Not Found!\n\n`)
      markdown.appendMarkdown(`ID: ${escapeMarkdown(entityIdToLookup)}\n\n`)

      // Get all entity IDs from registry
      const allEntityIds = [
        ...Array.from(this.registry.jsonSchemas.keys()),
        ...Array.from(this.registry.jsonObjs.keys())
      ].filter(id => isGtsId(id)) // Only suggest valid GTS IDs

      // Find similar entities that actually resolve to a registry entity, so
      // the "Did you mean" header is only shown when there is at least one
      // clickable suggestion to render underneath it.
      const suggestions = findSimilarEntityIds(entityIdToLookup, allEntityIds, 3)
      const suggestionLines = this.buildSuggestionLines(suggestions, document, hoverRange)

      if (suggestionLines.length > 0) {
        markdown.appendMarkdown(`**Did you mean:** (click to replace)\n\n`)
        for (const line of suggestionLines) markdown.appendMarkdown(line)
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

    // The analyzer flagged this segment as an error even though the entity
    // exists → it is present but invalid. Surface that up front (with the
    // underlying GTS validation error when known) instead of masquerading as
    // "not found"; the definition link below still lets the user navigate to it.
    if (hoveredSeg && hoveredSeg.type === 'error') {
      markdown.appendMarkdown(`⚠️ GTS Entity Invalid\n\n`)
      const firstError = entity.validation?.errors?.[0]
      if (firstError?.message) {
        markdown.appendMarkdown(`${escapeMarkdown(firstError.message)}\n\n`)
      }
    }

    // Add file path as a clickable link
    const lineNumber = await findDefinitionLine(entity)
    const fileUri = vscode.Uri.file(entity.file.path).with({
      fragment: `L${lineNumber + 1}`
    })
    const relativePath = getRelativePath(entity.file.path)

    // Make the GTS ID itself clickable
    markdown.appendMarkdown(`GTS ID: [${escapeMarkdown(entityIdToLookup)}](${fileUri.toString()})\n\n`)
    markdown.appendMarkdown(`Kind: ${entityType}\n\n`)
    markdown.appendMarkdown(`Definition: [${escapeMarkdown(relativePath)}](${fileUri.toString()})`)

    // Add description if available (on a new line, no label)
    const description = entity.description || ''
    if (description && description !== entityIdToLookup) {
      markdown.appendMarkdown(`\n\nDescription: ${escapeMarkdown(description)}`)
    }

    return new vscode.Hover(markdown, hoverRange)
  }
}
