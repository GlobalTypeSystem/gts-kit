import * as vscode from 'vscode'
import * as path from 'path'
import { JsonRegistry, ValidationError, DEFAULT_GTS_CONFIG, parseJSONC } from '@gts/shared'
import { getLastScanFiles } from './scanStore'
import { isGtsCandidateFile } from './helpers'

let diagnosticCollection: vscode.DiagnosticCollection
let isInitialScanComplete = false
const changeTimers = new Map<string, NodeJS.Timeout>()


/**
 * Convert validation errors to VSCode diagnostics
 */
function validationErrorsToDiagnostics(errors: ValidationError[], document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []

  for (const error of errors) {
    // Try to find the error location in the document
    let range: vscode.Range

    // If we have an instancePath, try to locate it in the document
    if (error.instancePath) {
      const position = findErrorPosition(document, error.instancePath, error)
      if (position) {
        range = position
      } else {
        // Fallback to start of document
        range = new vscode.Range(0, 0, 0, 1)
      }
    } else {
      // General error at start of document
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

  // For additionalProperties errors, look for the actual property mentioned in params
  if (error.keyword === 'additionalProperties' && error.params && 'additionalProperty' in error.params) {
    const additionalProp = (error.params as any).additionalProperty
    const searchPattern = new RegExp(`["']${escapeRegex(additionalProp)}["']\\s*:`, 'g')
    const match = searchPattern.exec(text)
    if (match) {
      const startPos = document.positionAt(match.index + 1) // +1 to skip opening quote
      const endPos = document.positionAt(match.index + 1 + additionalProp.length)
      return new vscode.Range(startPos, endPos)
    }
  }

  // For required property errors, find the parent object and place error at the opening brace
  if (error.keyword === 'required' && error.params && 'missingProperty' in error.params) {
    const missingProp = (error.params as any).missingProperty

    // Try to find the parent object by navigating through the path
    if (!path) {
      // Error at root level - find first opening brace
      const rootMatch = text.match(/\{/)
      if (rootMatch && rootMatch.index !== undefined) {
        const pos = document.positionAt(rootMatch.index)
        return new vscode.Range(pos, pos.translate(0, 1))
      }
    } else {
      // Find the object that should contain this property
      const segments = path.split('/')
      const lastSegment = segments[segments.length - 1]

      if (lastSegment && !/^\d+$/.test(lastSegment)) {
        // Find the parent property
        const searchPattern = new RegExp(`["']${escapeRegex(lastSegment)}["']\\s*:\\s*\\{`, 'g')
        const match = searchPattern.exec(text)
        if (match) {
          const pos = document.positionAt(match.index + 1)
          const endPos = document.positionAt(match.index + 1 + lastSegment.length)
          return new vscode.Range(pos, endPos)
        }
      }
    }
  }

  // General case: try to find the property mentioned in the path
  if (path) {
    const segments = path.split('/')
    const lastSegment = segments[segments.length - 1]

    if (lastSegment && !/^\d+$/.test(lastSegment)) {
      // Not an array index, try to find the property name
      const searchPattern = new RegExp(`["']${escapeRegex(lastSegment)}["']\\s*:`, 'g')
      const match = searchPattern.exec(text)
      if (match) {
        const startPos = document.positionAt(match.index + 1) // +1 to skip opening quote
        const endPos = document.positionAt(match.index + 1 + lastSegment.length)
        return new vscode.Range(startPos, endPos)
      }
    }
  }

  // Fallback: return null to use default position
  return null
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Validate a document and update diagnostics
 */
async function validateDocument(document: vscode.TextDocument) {
  // Only validate JSON and GTS files
  const isJsonOrGts = isGtsCandidateFile(document)

  if (!isJsonOrGts) {
    return
  }

  try {
    const text = document.getText()
    const fileName = path.basename(document.fileName)
    const filePath = document.uri.fsPath

    console.log(`[GTS Validation] Validating: ${filePath}`)

    // Parse the document content to JSON
    let content: any
    try {
      content = parseJSONC(text)
    } catch (parseError: any) {
      console.log(`[GTS Validation] Failed to parse JSON: ${parseError.message}`)
      // If parsing fails, store as text and let registry handle it
      content = text
    }

    const files = getLastScanFiles()

    if (files.length === 0 && !isInitialScanComplete) {
      console.log(`[GTS Validation] ⚠️  Initial workspace scan not yet complete - validation may be incomplete`)
    }

    const withoutCurrent = files.filter(f => f.path !== filePath)
    const merged = [...withoutCurrent, { path: filePath, name: fileName, content }]

    const registry = new JsonRegistry()
    console.log(`[GTS Validation] Ingesting ${merged.length} files into GTS registry...`)
    await registry.ingestFiles(merged, DEFAULT_GTS_CONFIG)

    let errors: ValidationError[] = []

    const invalid = registry.invalidFiles.get(filePath)

    if (invalid?.validation && !invalid.validation.valid && invalid.validation.errors.length > 0) {
      errors = invalid.validation.errors
    } else {
      const fileObjs = Array.from(registry.jsonObjs.values()).filter(o => o.file?.path === filePath)
      const fileSchemas = Array.from(registry.jsonSchemas.values()).filter(s => s.file?.path === filePath)

      for (const e of [...fileObjs, ...fileSchemas]) {
        if (e.validation && e.validation.valid === false && e.validation.errors.length > 0) {
          errors.push(...e.validation.errors)
        }
      }
    }

    if (errors.length > 0) {
      const diagnostics = validationErrorsToDiagnostics(errors, document)
      diagnosticCollection.set(document.uri, diagnostics)
      console.log(`[GTS Validation] ✗ Got ${diagnostics.length} GTS diagnostics errors for ${fileName} - Errors:`, diagnostics.map(d => ({ message: d.message, range: d.range })))
    } else {
      diagnosticCollection.delete(document.uri)
      console.log(`[GTS Validation] ✓ No errors, cleared diagnostics for ${fileName}`)
    }
  } catch (error) {
    console.error('[GTS Validation] ✗ Error validating document:', error)
    diagnosticCollection.delete(document.uri)
  }
}

export function initValidation(context: vscode.ExtensionContext) {
    console.log('[GTS Validation] Initializing validation system...')

    // Create diagnostic collection for validation errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('gts')
    context.subscriptions.push(diagnosticCollection)

    // Validate all open documents on activation
    const openDocs = vscode.workspace.textDocuments
    console.log(`[GTS Validation] Validating ${openDocs.length} open documents on activation`)
    openDocs.forEach(doc => {
      void validateDocument(doc)
    })

    // Validate document when it's opened
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        console.log(`[GTS Validation] Document opened: ${doc.fileName} (language: ${doc.languageId})`)
        void validateDocument(doc)
      })
    )

    // Validate document when it changes (debounced - 1 second after user stops typing)
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!isGtsCandidateFile(event.document)) return

        const docUri = event.document.uri.toString()

        // Clear any existing timer for this document
        const existingTimer = changeTimers.get(docUri)
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        // Set new timer to validate 0.5 seconds after user stops typing
        const timer = setTimeout(() => {
          console.log(`[GTS Validation] Document changed (after 0.5s delay): ${event.document.fileName}`)
          changeTimers.delete(docUri)
          void validateDocument(event.document)
        }, 500)

        changeTimers.set(docUri, timer)
      })
    )

    // Validate document when it's saved
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        console.log(`[GTS Validation] Document saved: ${doc.fileName}`)

        // Clear any pending validation timer since we're validating now
        const docUri = doc.uri.toString()
        const existingTimer = changeTimers.get(docUri)
        if (existingTimer) {
          clearTimeout(existingTimer)
          changeTimers.delete(docUri)
        }

        void validateDocument(doc)
      })
    )

    // Clear diagnostics when document is closed
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        console.log(`[GTS Validation] Document closed: ${doc.fileName}`)

        // Clear any pending validation timer for this document
        const docUri = doc.uri.toString()
        const existingTimer = changeTimers.get(docUri)
        if (existingTimer) {
          clearTimeout(existingTimer)
          changeTimers.delete(docUri)
        }

        diagnosticCollection.delete(doc.uri)
      })
    )

    console.log('[GTS Validation] Validation system initialized successfully')
}

/**
 * Notify validation system that initial workspace scan is complete
 * This will trigger re-validation of all open documents
 */
export function notifyInitialScanComplete() {
  console.log('[GTS Validation] Initial scan complete, re-validating open documents...')
  isInitialScanComplete = true

  // Re-validate all open documents now that we have the full registry
  vscode.workspace.textDocuments.forEach(doc => {
    if (isGtsCandidateFile(doc)) {
      console.log(`[GTS Validation] Re-validating after scan: ${doc.fileName}`)
      void validateDocument(doc)
    }
  })
}
