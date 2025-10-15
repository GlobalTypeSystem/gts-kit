import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/$/, '')
}

export function getFileName(path: string): string {
  return path.split('/').pop() || path
}

export function getFileExtension(path: string): string {
  return path.split('.').pop() || ''
}

/**
 * Split a GTS-like filename on the last tilde and return HTML string:
 * - prefix (before last ~) in small text with trailing tilde
 * - <br>
 * - tail (after last ~) as normal text
 * If no tilde is present, returns the original text.
 */
export function renderGtsNameWithBreak(name: string): string {
  let idx = -1
  if (name.endsWith('~')) {
    let _name = name.slice(0, name.length - 1)
    idx = _name.lastIndexOf('~')
  } else {
    idx = name.lastIndexOf('~')
  }
  if (idx === -1) return name
  const head = name.slice(0, idx + 1)
  const tail = name.slice(idx + 1)
  return `<small>${head}</small><br>${tail}`
}
