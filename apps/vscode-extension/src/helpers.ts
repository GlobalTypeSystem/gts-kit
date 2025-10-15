import * as vscode from 'vscode'
import { isGtsCandidateFileName } from '@gts/shared'

export function isGtsCandidateFile(document: vscode.TextDocument): boolean {
    return document.languageId === 'json' ||
           document.languageId === 'jsonc' ||
           isGtsCandidateFileName(document.fileName)
}
