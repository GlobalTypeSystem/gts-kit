#!/usr/bin/env node
import { startServer } from './server.js'
import { loadConfig, printConfig, printHelp } from './config.js'

// Check for help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp()
  process.exit(0)
}

// CLI entry point
async function main() {
  const config = await loadConfig(process.argv.slice(2))

  if (config.verbosity !== 'silent') {
    printConfig(config)
  }

  await startServer(config)
}

main().catch((err) => {
  console.error('[GTS API] Failed to start server:', err)
  process.exit(1)
})
