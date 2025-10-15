let lastFiles: Array<{ path: string; name: string; content: any }> = []

export function setLastScanFiles(files: Array<{ path: string; name: string; content: any }>): void {
  lastFiles = files
}

export function getLastScanFiles(): Array<{ path: string; name: string; content: any }> {
  return lastFiles
}
