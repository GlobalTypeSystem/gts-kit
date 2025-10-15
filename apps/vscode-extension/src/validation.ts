import * as vscode from 'vscode'
import * as path from 'path'
import { JsonRegistry, ValidationError, DEFAULT_GTS_CONFIG } from '@gts/shared'
import { getLastScanFiles } from './scanStore'
import { isGtsCandidateFile } from './helpers'

let diagnosticCollection: vscode.DiagnosticCollection


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
      const position = findErrorPosition(document, error.instancePath)
      if (position) {
        range = new vscode.Range(position, position.translate(0, 10))
      } else {
        // Fallback to start of document
        range = new vscode.Range(0, 0, 0, 10)
      }
    } else {
      // General error at start of document
      range = new vscode.Range(0, 0, 0, 10)
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
 * Find the position of an error in the document based on instancePath
 */
function findErrorPosition(document: vscode.TextDocument, instancePath: string): vscode.Position | null {
  const text = document.getText()

  // Remove leading slash from instancePath (e.g., '/users/0/email' -> 'users/0/email')
  const path = instancePath.replace(/^\//, '')

  if (!path) {
    // Error at root
    return new vscode.Position(0, 0)
  }

  // Split the path into segments (e.g., 'users/0/email' -> ['users', '0', 'email'])
  const segments = path.split('/')

  // Try to find the last segment in the document (most specific field)
  const lastSegment = segments[segments.length - 1]
  if (lastSegment && !/^\d+$/.test(lastSegment)) {
    // Not an array index, try to find the property name
    const searchPattern = new RegExp(`["']${lastSegment}["']\\s*:`, 'g')
    const match = searchPattern.exec(text)
    if (match) {
      const position = document.positionAt(match.index)
      return position
    }
  }

  // Fallback: return null to use default position
  return null
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

    const files = getLastScanFiles()
    const withoutCurrent = files.filter(f => f.path !== filePath)
    const merged = [...withoutCurrent, { path: filePath, name: fileName, content: text }]

    const registry = new JsonRegistry()
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
      console.log(`[GTS] Found ${diagnostics.length} validation errors in ${fileName}`)
    } else {
      diagnosticCollection.delete(document.uri)
    }
  } catch (error) {
    console.error('[GTS] Error validating document:', error)
    diagnosticCollection.delete(document.uri)
  }
}

export function initValidation(context: vscode.ExtensionContext) {
    // Create diagnostic collection for validation errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('gts')
    context.subscriptions.push(diagnosticCollection)

    // Validate all open documents on activation
    vscode.workspace.textDocuments.forEach(doc => { void validateDocument(doc) })

    // Validate document when it's opened
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(doc => { void validateDocument(doc) })
    )

    // Validate document when it changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => { void validateDocument(event.document) })
    )

    // Validate document when it's saved
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => { void validateDocument(doc) })
    )

    // Clear diagnostics when document is closed
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(doc => {
        diagnosticCollection.delete(doc.uri)
      })
    )
}
