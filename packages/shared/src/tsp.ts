import { NodeHost, compile } from '@typespec/compiler'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Check if TypeSpec compiler is available
 * Since we now include it as a dependency, it is always available.
 * Keeping this for backward compatibility and potential runtime checks.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function isTspAvailable(): Promise<boolean> {
    return true
}

/**
 * Compile a TypeSpec file to JSON Schema
 * 
 * @param filePath - Path to the .tsp file
 * @param fileContent - Content of the .tsp file (unused in NodeHost mode as it reads from FS)
 * @returns Parsed JSON Schema content or null if compilation fails
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function compileTsp(filePath: string, fileContent?: string): Promise<any | null> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-'))
    const outputDir = path.join(tmpDir, 'output')

    try {
        const program = await compile(NodeHost, filePath, {
            outputDir: outputDir,
            emit: ["@typespec/json-schema"],
            options: {
                "@typespec/json-schema": {
                    "file-type": "json"
                }
            }
        });

        // Check for errors
        if (program.diagnostics.some(d => d.severity === 'error')) {
            const errors = program.diagnostics
                .filter(d => d.severity === 'error')
                .map(d => d.message)
                .join('\n');
            console.warn(`TypeSpec compilation errors for ${filePath}:\n${errors}`);
            return null;
        }

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
