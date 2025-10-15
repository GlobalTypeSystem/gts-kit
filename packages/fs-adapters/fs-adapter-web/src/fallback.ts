import { Scanner, ScanOptions, JsonDoc, FileChange } from '../../types'
import { isGtsCandidateFileName } from '@gts/shared'

/**
 * Fallback scanner for browsers that don't support File System Access API
 * Uses traditional file input with webkitdirectory attribute
 */
export class WebFallbackScanner implements Scanner {
  private files: File[] = []
  private fileMap: Map<string, File> = new Map()

  async requestDirectoryAccess(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a hidden file input element
      const input = document.createElement('input')
      input.type = 'file'
      input.webkitdirectory = true
      input.multiple = true
      input.style.display = 'none'

      input.onchange = (event) => {
        const target = event.target as HTMLInputElement
        if (!target.files || target.files.length === 0) {
          reject(new Error('No directory selected'))
          return
        }

        // Store files and create file map
        this.files = Array.from(target.files)
        this.fileMap.clear()

        for (const file of this.files) {
          // Use relative path from the selected directory
          const relativePath = file.webkitRelativePath
          this.fileMap.set(relativePath, file)
        }

        console.log(`[WebFallbackScanner] Loaded ${this.files.length} files from directory`)

        // Clean up
        document.body.removeChild(input)
        resolve()
      }

      input.oncancel = () => {
        document.body.removeChild(input)
        reject(new Error('Directory selection cancelled'))
      }

      // Add to DOM and trigger click
      document.body.appendChild(input)
      input.click()
    })
  }

  async list(opts: ScanOptions = {}): Promise<JsonDoc[]> {
    const ignore = opts.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**"]
    const jsonDocs: JsonDoc[] = []

    for (const [relativePath, file] of this.fileMap) {
      // Skip non-eligible files
      if (!isGtsCandidateFileName(file.name)) continue

      // Check if file should be ignored
      if (this.isIgnored(relativePath, ignore)) continue

      jsonDocs.push({
        path: relativePath,
        name: file.name,
        mtimeMs: file.lastModified,
        size: file.size
      })
    }

    return jsonDocs
  }

  async read(path: string): Promise<string> {
    const file = this.fileMap.get(path)
    if (!file) {
      throw new Error(`File not found: ${path}`)
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => {
        // Provide more helpful error message for file reading failures
        reject(new Error(`Failed to read file: ${path}. This may happen if the file was modified after directory selection. Please re-select the directory to refresh file contents.`))
      }
      reader.readAsText(file)
    })
  }

  watch(_opts: ScanOptions, _onChange: (ev: FileChange) => void): () => void {
    // File watching is not supported with traditional file input
    // Return a no-op cleanup function
    return () => {}
  }

  private isIgnored(path: string, ignore: string[]): boolean {
    // Minimal ignore: treat patterns as directory substrings like "node_modules"/".git"/"dist"
    return ignore.some(p => {
      const seg = p.replace(/\*\*\//g, "").replace(/\*\*/g, "").replace(/\*/g, "")
      return seg && path.includes(seg)
    })
  }
}
