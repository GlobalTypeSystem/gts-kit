// Purpose: implement Scanner using File System Access API for the browser
// path: packages/fs-adapters/fs-adapter-web-fsa/src/index.ts
import { Scanner, ScanOptions, JsonDoc, FileChange } from "../../types";

// Check if File System Access API is supported
function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' &&
         'showDirectoryPicker' in window &&
         typeof (window as any).showDirectoryPicker === 'function';
}

type FileHandleIndex = Map<string, FileSystemFileHandle>

export class WebFsaScanner implements Scanner {
  private dir?: FileSystemDirectoryHandle
  private index: FileHandleIndex = new Map()

  async requestDirectoryAccess() {
    // Check if File System Access API is supported
    if (!isFileSystemAccessSupported()) {
      throw new Error('File System Access API is not supported in this browser. Please use Chrome, Edge, or another Chromium-based browser for full directory access functionality.')
    }

    // Requires explicit user gesture from the caller
    this.dir = await (window as any).showDirectoryPicker()
    // Reset any previous index
    this.index.clear()
  }

  private isIgnored(path: string, ignore: string[]): boolean {
    // Minimal ignore: treat patterns as directory substrings like "node_modules"/".git"/"dist"
    return ignore.some(p => {
      const seg = p.replace(/\*\*\//g, "").replace(/\*\*/g, "").replace(/\*/g, "")
      return seg && path.includes(seg)
    })
  }

  async list(opts: ScanOptions = {}): Promise<JsonDoc[]> {
    if (!this.dir) throw new Error("No directory handle")
    const ignore = opts.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**"]
    const out: JsonDoc[] = []
    this.index.clear()

    const walk = async (dir: FileSystemDirectoryHandle, prefix: string = "") => {
      // for await...of over directory entries
      for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
        const name = (entry as any).name as string
        const relPath = prefix ? `${prefix}/${name}` : name
        if (entry.kind === "directory") {
          if (this.isIgnored(relPath + "/", ignore)) continue
          await walk(entry as FileSystemDirectoryHandle, relPath)
        } else if (entry.kind === "file") {
          if (!name.toLowerCase().endsWith(".json")) continue
          if (this.isIgnored(relPath, ignore)) continue
          const fh = entry as FileSystemFileHandle
          try {
            const file = await fh.getFile()
            out.push({ path: relPath, name, mtimeMs: file.lastModified, size: file.size })
            this.index.set(relPath, fh)
          } catch {
            // Skip unreadable entries
          }
        }
      }
    }

    await walk(this.dir)
    return out
  }

  async read(path: string): Promise<string> {
    const fh = this.index.get(path)
    if (!fh) throw new Error(`No handle for path: ${path}`)
    const file = await fh.getFile()
    return await file.text()
  }

  watch(_opts: ScanOptions, _cb: (ev: FileChange) => void) {
    // Browsers have no native directory watchers; a simple polling stub
    // Callers may choose to invoke list() periodically instead.
    return () => {
      // no-op
    }
  }
}
