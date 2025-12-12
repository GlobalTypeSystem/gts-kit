import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const execAsync = promisify(exec)

/**
 * Check if TypeSpec compiler is available
 */
async function isTspAvailable(): Promise<boolean> {
    try {
        await execAsync('tsp --version')
        return true
    } catch {
        // Try with npx
        try {
            await execAsync('npx --yes @typespec/compiler --version', { timeout: 30000 })
            return true
        } catch {
            return false
        }
    }
}

/**
 * Compile a TypeSpec file to JSON Schema
 * 
 * @param filePath - Path to the .tsp file
 * @param fileContent - Content of the .tsp file (for writing to temp file if needed)
 * @returns Parsed JSON Schema content or null if compilation fails
 */
export async function compileTsp(filePath: string, fileContent?: string): Promise<any | null> {
    const available = await isTspAvailable()
    if (!available) {
        console.warn(`TypeSpec compiler not available, skipping: ${filePath}`)
        return null
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-'))
    const outputDir = path.join(tmpDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    try {
        // Determine which command to use
        let cmd: string
        try {
            await execAsync('tsp --version')
            cmd = 'tsp'
        } catch {
            cmd = 'npx --yes @typespec/compiler'
        }

        const compileCmd = `${cmd} compile "${filePath}" --emit @typespec/json-schema --output-dir "${outputDir}"`

        await execAsync(compileCmd, {
            cwd: path.dirname(filePath),
            timeout: 60000
        })

        // Find generated schema files
        const schemaFiles = findJsonFiles(outputDir)
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

    } catch (error) {
        console.warn(`TypeSpec compilation failed for ${filePath}:`, error)
        return null
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
 * Recursively find all JSON files in a directory
 */
function findJsonFiles(dir: string): string[] {
    const results: string[] = []

    if (!fs.existsSync(dir)) return results

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            results.push(...findJsonFiles(fullPath))
        } else if (entry.name.endsWith('.json')) {
            results.push(fullPath)
        }
    }

    return results
}

/**
 * Try to compile TypeSpec, return null on failure
 */
export async function tryCompileTsp(filePath: string): Promise<any | null> {
    try {
        return await compileTsp(filePath)
    } catch {
        return null
    }
}
