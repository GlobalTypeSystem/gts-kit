import * as vscode from 'vscode'
import * as fs from 'fs'
import { isGtsCandidateFileName } from '@gts/shared'

export function isGtsCandidateFile(document: vscode.TextDocument): boolean {
    // Only real on-disk files belong in the workspace registry. Virtual documents
    // (git:/ quick-diff originals, compare views, untitled buffers) share the real
    // file's fsPath but hold different content; indexing them would overwrite the
    // working copy's entities and churn the registry on every file open.
    if (document.uri.scheme !== 'file') return false
    return document.languageId === 'json' ||
           document.languageId === 'jsonc' ||
           isGtsCandidateFileName(document.fileName)
}

export function isIndexableGtsDocument(document: vscode.TextDocument): boolean {
    return isGtsCandidateFile(document) && (document.isDirty || fs.existsSync(document.uri.fsPath))
}
