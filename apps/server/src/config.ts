import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { cwd } from 'node:process'
import { GtsConfig, DEFAULT_GTS_CONFIG } from '@gts/shared'

export type VerbosityLevel = 'silent' | 'normal' | 'debug'

export interface ServerConfig {
  gts: GtsConfig
  port: number
  homeFolder: string
  scanFolder: string
  verbosity: VerbosityLevel
  dbFile?: string
  defaultWorkspace: string
}

export interface ConfigFileSchema {
  port?: number
  homeFolder?: string
  scanFolder?: string
  verbosity?: VerbosityLevel
  dbFile?: string
}

const DEFAULT_CONFIG: ServerConfig = {
  gts: DEFAULT_GTS_CONFIG,
  port: 7080,
  homeFolder: resolve(homedir(), '.gts-viewer', 'server'),
  scanFolder: cwd(),
  verbosity: 'normal',
  defaultWorkspace: 'default'
}

/**
 * Load configuration from file if it exists
 */
async function loadConfigFile(configPath?: string): Promise<Partial<ServerConfig>> {
  const paths = configPath
    ? [configPath]
    : [
        resolve(cwd(), '.gts-server.json'),
        resolve(cwd(), 'gts-server.json'),
        resolve(homedir(), '.gts-server.json')
      ]

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = await readFile(path, 'utf-8')
        const config: ConfigFileSchema = JSON.parse(content)
        return config
      } catch (error) {
        console.warn(`[GTS Config] Failed to load config from ${path}:`, error)
      }
    }
  }

  return {}
}

/**
 * Parse command line arguments
 */
export function parseCliArgs(args: string[]): Partial<ServerConfig> & { configFile?: string } {
  const config: Partial<ServerConfig> & { configFile?: string } = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--port':
      case '-p':
        if (i + 1 < args.length) {
          config.port = parseInt(args[++i], 10)
        }
        break

      case '--home':
      case '--home-folder':
        if (i + 1 < args.length) {
          config.homeFolder = resolve(args[++i])
        }
        break

      case '--scan':
      case '--scan-folder':
        if (i + 1 < args.length) {
          config.scanFolder = resolve(args[++i])
        }
        break

      case '--verbosity':
      case '-v':
        if (i + 1 < args.length) {
          const level = args[++i]
          if (level === 'silent' || level === 'normal' || level === 'debug') {
            config.verbosity = level
          }
        }
        break

      case '--debug':
        config.verbosity = 'debug'
        break

      case '--silent':
        config.verbosity = 'silent'
        break

      case '--db':
      case '--db-file':
        if (i + 1 < args.length) {
          config.dbFile = args[++i]
        }
        break

      case '--config':
      case '-c':
        if (i + 1 < args.length) {
          config.configFile = args[++i]
        }
        break
    }
  }

  return config
}

/**
 * Load and merge configuration from multiple sources
 * Priority: CLI args > Config file > Environment variables > Defaults
 */
export async function loadConfig(cliArgs?: string[]): Promise<ServerConfig> {
  // Parse CLI arguments first to see if custom config file is specified
  const cliConfig = cliArgs ? parseCliArgs(cliArgs) : {}

  // Load config file
  const fileConfig = await loadConfigFile(cliConfig.configFile)

  // Environment variables
  const envConfig: Partial<ServerConfig> = {}
  if (process.env.GTS_SERVER_PORT) {
    envConfig.port = parseInt(process.env.GTS_SERVER_PORT, 10)
  }
  if (process.env.GTS_SERVER_HOME_FOLDER) {
    envConfig.homeFolder = resolve(process.env.GTS_SERVER_HOME_FOLDER)
  }
  if (process.env.GTS_SERVER_SCAN_FOLDER) {
    envConfig.scanFolder = resolve(process.env.GTS_SERVER_SCAN_FOLDER)
  }
  if (process.env.GTS_SERVER_VERBOSITY) {
    const v = process.env.GTS_SERVER_VERBOSITY
    if (v === 'silent' || v === 'normal' || v === 'debug') {
      envConfig.verbosity = v
    }
  }
  if (process.env.GTS_SERVER_DB_FILE) {
    envConfig.dbFile = process.env.GTS_SERVER_DB_FILE
  }

  // Merge configurations (CLI > File > Env > Default)
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...fileConfig,
    ...cliConfig
  }

  // Resolve dbFile path if not absolute, relative to homeFolder
  if (!config.dbFile) {
    config.dbFile = resolve(config.homeFolder, 'viewer.db')
  } else if (!config.dbFile.startsWith('/')) {
    config.dbFile = resolve(config.homeFolder, config.dbFile)
  }

  return config
}

/**
 * Print configuration (useful for debugging)
 */
export function printConfig(config: ServerConfig): void {
  console.log('[GTS Config] Configuration:')
  console.log(`  Port:              ${config.port}`)
  console.log(`  Home Folder:       ${config.homeFolder}`)
  console.log(`  Scan Folder:       ${config.scanFolder}`)
  console.log(`  Verbosity:         ${config.verbosity}`)
  console.log(`  DB File:           ${config.dbFile}`)
  console.log(`  Default Workspace: ${config.defaultWorkspace}`)
}

/**
 * Print help message
 */
export function printHelp(): void {
  console.log(`
GTS Server - Configuration Options

Usage: gts-server [options]

Options:
  --port, -p <number>           Port to listen on (default: 7080)
  --home, --home-folder <path>  Home folder for server data (default: ~/.gts-viewer/server/)
  --scan, --scan-folder <path>  Folder to scan for GTS entities (default: current directory)
  --verbosity, -v <level>       Verbosity level: silent, normal, debug (default: normal)
  --debug                       Enable debug verbosity
  --silent                      Enable silent verbosity
  --db, --db-file <path>        Database file path (default: <home-folder>/viewer.db)
  --config, -c <path>           Path to config file
  --help, -h                    Show this help message

Config File:
  The server looks for configuration in the following locations (in order):
  1. Path specified with --config flag
  2. .gts-server.json in current directory
  3. gts-server.json in current directory
  4. ~/.gts-server.json in home directory

  Config file format (JSON):
  {
    "port": 7080,
    "homeFolder": "~/.gts-viewer/server",
    "scanFolder": ".",
    "verbosity": "normal",
    "dbFile": "viewer.db"
  }

Environment Variables:
  GTS_SERVER_PORT       Port to listen on
  GTS_SERVER_HOME_FOLDER       Home folder path
  GTS_SERVER_SCAN_FOLDER       Folder to scan
  GTS_SERVER_VERBOSITY         Verbosity level
  GTS_SERVER_DB_FILE    Database file path

Priority: CLI args > Config file > Environment variables > Defaults
`)
}
