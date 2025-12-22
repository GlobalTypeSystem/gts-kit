import {
    compile,
    type CompilerHost,
    type SourceFile,
    type Diagnostic,
    getSourceFileKindFromExt,
    NodeHost
} from '@typespec/compiler'

/**
 * Virtual file system for in-memory TypeSpec compilation
 * Works in both Node.js and browser environments
 */
class VirtualFileSystem {
    private files = new Map<string, string>()

    set(path: string, content: string): void {
        const normalizedPath = this.normalizePath(path)
        this.files.set(normalizedPath, content)
    }

    get(path: string): string | undefined {
        return this.files.get(this.normalizePath(path))
    }

    has(path: string): boolean {
        return this.files.has(this.normalizePath(path))
    }

    delete(path: string): boolean {
        return this.files.delete(this.normalizePath(path))
    }

    list(dir: string): string[] {
        const normalizedDir = this.normalizePath(dir)
        const results: string[] = []
        for (const key of this.files.keys()) {
            if (key.startsWith(normalizedDir)) {
                const relative = key.slice(normalizedDir.length)
                const firstSegment = relative.split('/').filter(Boolean)[0]
                if (firstSegment && !results.includes(firstSegment)) {
                    results.push(firstSegment)
                }
            }
        }
        return results
    }

    getAll(): Map<string, string> {
        return new Map(this.files)
    }

    private normalizePath(path: string): string {
        // Normalize to forward slashes and ensure leading slash
        let normalized = path.replace(/\\/g, '/')
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized
        }
        // Remove trailing slash except for root
        if (normalized.length > 1 && normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1)
        }
        return normalized
    }
}

/**
 * Check if we're running in a browser environment
 */
function isBrowser(): boolean {
    // Check for browser globals without requiring DOM types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof (globalThis as any).window !== 'undefined' &&
           typeof (globalThis as any).document !== 'undefined'
}

/**
 * Create a browser-compatible CompilerHost
 */
function createBrowserHost(vfs: VirtualFileSystem): CompilerHost {
    const jsImports = new Map<string, any>()

    return {
        // Logging
        logSink: console,

        // File operations using virtual file system
        async readFile(path: string): Promise<SourceFile> {
            const content = vfs.get(path)
            if (content === undefined) {
                const error = new Error(`ENOENT: no such file or directory: ${path}`) as NodeJS.ErrnoException
                error.code = 'ENOENT'
                throw error
            }
            return {
                path,
                text: content
            } as SourceFile
        },

        async readDir(path: string): Promise<string[]> {
            return vfs.list(path)
        },

        async writeFile(path: string, content: string): Promise<void> {
            vfs.set(path, content)
        },

        async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
            if (options?.recursive) {
                const normalizedPath = path.replace(/\\/g, '/')
                for (const key of vfs.getAll().keys()) {
                    if (key.startsWith(normalizedPath)) {
                        vfs.delete(key)
                    }
                }
            } else {
                vfs.delete(path)
            }
        },

        async mkdirp(_path: string): Promise<string | undefined> {
            // No-op for virtual FS - directories are implicit
            return undefined
        },

        async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
            const hasFile = vfs.has(path)
            const hasChildren = vfs.list(path).length > 0

            if (hasFile) {
                return { isDirectory: () => false, isFile: () => true }
            }
            if (hasChildren) {
                return { isDirectory: () => true, isFile: () => false }
            }

            const error = new Error(`ENOENT: no such file or directory: ${path}`) as NodeJS.ErrnoException
            error.code = 'ENOENT'
            throw error
        },

        async realpath(path: string): Promise<string> {
            return path
        },

        // URL/Path conversion for virtual "inmemory:" scheme
        fileURLToPath(url: string): string {
            if (url.startsWith('inmemory:')) {
                return url.slice('inmemory:'.length)
            }
            if (url.startsWith('file:')) {
                return url.slice('file://'.length)
            }
            return url
        },

        pathToFileURL(path: string): string {
            return `inmemory:${path}`
        },

        async readUrl(url: string): Promise<SourceFile> {
            const path = this.fileURLToPath(url)
            return this.readFile(path)
        },

        // Runtime information
        getExecutionRoot(): string {
            return '/'
        },

        getLibDirs(): string[] {
            return ['/lib']
        },

        getSourceFileKind(path: string) {
            return getSourceFileKindFromExt(path)
        },

        // Dynamic imports - limited in browser
        async getJsImport(path: string): Promise<Record<string, any>> {
            const cached = jsImports.get(path)
            if (cached) return cached

            // In browser, we can only import pre-bundled modules
            throw new Error(`MODULE_NOT_FOUND: Cannot dynamically import ${path} in browser environment`)
        }
    }
}

/**
 * Compile a TypeSpec file to JSON Schema
 * Works in both Node.js and browser environments
 *
 * @param filePath - Path to the .tsp file
 * @param fileContent - Content of the .tsp file (optional in Node.js, required in browser)
 * @returns Parsed JSON Schema content or null if compilation fails
 */
export async function compileTsp(filePath: string, fileContent?: string): Promise<any | null> {
    // In Node.js environment, always use NodeHost for reliable compilation
    // NodeHost handles library resolution, file system, and all dependencies
    if (!isBrowser()) {
        try {
            return await compileTspWithNodeHost(filePath)
        } catch (error) {
            console.warn(`TypeSpec compilation failed for ${filePath}:`, error)
            return null
        }
    }

    // Browser environment - use virtual file system
    // Note: Browser mode requires @typespec/json-schema to be bundled with the app
    if (!fileContent) {
        console.warn(`TypeSpec compilation in browser requires file content for ${filePath}`)
        return null
    }

    const vfs = new VirtualFileSystem()
    vfs.set(filePath, fileContent)
    const host = createBrowserHost(vfs)

    try {
        const program = await compile(host, filePath, {
            outputDir: '/tsp-output',
            emit: ['@typespec/json-schema'],
            options: {
                '@typespec/json-schema': {
                    'file-type': 'json'
                }
            }
        })

        // Check for errors
        const errors = program.diagnostics.filter((d: Diagnostic) => d.severity === 'error')
        if (errors.length > 0) {
            const errorMessages = errors.map((d: Diagnostic) => d.message).join('\n')
            console.warn(`TypeSpec compilation errors for ${filePath}:\n${errorMessages}`)
            return null
        }

        // Find generated schema files in virtual FS
        const outputFiles = findOutputFiles(vfs, '/tsp-output')
        if (outputFiles.length === 0) {
            console.warn(`No JSON Schema generated for ${filePath}`)
            return null
        }

        // Parse and return schemas
        const schemas = outputFiles.map(f => {
            const content = vfs.get(f)
            if (!content) return null
            try {
                return JSON.parse(content)
            } catch {
                return null
            }
        }).filter(Boolean)

        return schemas.length === 1 ? schemas[0] : schemas.length > 0 ? schemas : null

    } catch (error) {
        console.warn(`TypeSpec compilation failed for ${filePath}:`, error)
        return null
    }
}

/**
 * Compile TypeSpec using NodeHost (Node.js only)
 * Falls back to this when running in Node.js environment
 */
async function compileTspWithNodeHost(filePath: string): Promise<any | null> {
    const fs = await import('fs')
    const path = await import('path')
    const os = await import('os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-'))
    const outputDir = path.join(tmpDir, 'output')

    try {
        const program = await compile(NodeHost, filePath, {
            outputDir: outputDir,
            emit: ['@typespec/json-schema'],
            options: {
                '@typespec/json-schema': {
                    'file-type': 'json'
                }
            }
        })

        // Check for errors
        const errors = program.diagnostics.filter((d: Diagnostic) => d.severity === 'error')
        if (errors.length > 0) {
            const errorMessages = errors.map((d: Diagnostic) => d.message).join('\n')
            console.warn(`TypeSpec compilation errors for ${filePath}:\n${errorMessages}`)
            return null
        }

        // Find generated schema files
        const schemaFiles = findJsonFilesSync(outputDir, fs, path)
        if (schemaFiles.length === 0) {
            console.warn(`No JSON Schema generated for ${filePath}`)
            return null
        }

        // Read all generated schemas
        const schemas = schemaFiles.map(f => {
            const content = fs.readFileSync(f, 'utf-8')
            return JSON.parse(content)
        })

        return schemas.length === 1 ? schemas[0] : schemas

    } finally {
        // Cleanup temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    }
}

/**
 * Find all JSON files in virtual file system output directory
 */
function findOutputFiles(vfs: VirtualFileSystem, outputDir: string): string[] {
    const results: string[] = []
    for (const [path] of vfs.getAll()) {
        if (path.startsWith(outputDir) && path.endsWith('.json')) {
            results.push(path)
        }
    }
    return results
}

/**
 * Recursively find all JSON files in a directory (Node.js only)
 */
function findJsonFilesSync(
    dir: string,
    fs: typeof import('fs'),
    path: typeof import('path')
): string[] {
    const results: string[] = []

    if (!fs.existsSync(dir)) return results

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            results.push(...findJsonFilesSync(fullPath, fs, path))
        } else if (entry.name.endsWith('.json')) {
            results.push(fullPath)
        }
    }

    return results
}

/**
 * Try to compile TypeSpec, return null on failure (never throws)
 */
export async function tryCompileTsp(filePath: string, fileContent?: string): Promise<any | null> {
    try {
        return await compileTsp(filePath, fileContent)
    } catch {
        return null
    }
}

/**
 * Check if TypeSpec compilation is available in current environment
 */
export function isTspAvailable(): boolean {
    // TypeSpec compiler is now bundled as a dependency
    // Always available in both Node.js and browser
    return true
}
