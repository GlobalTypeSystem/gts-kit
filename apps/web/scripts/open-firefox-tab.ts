// scripts/open-firefox-tab.ts — open your dev URL in the BiDi-enabled Firefox
// Purpose: open the URL in the already-running Firefox instance
import { execSync } from 'node:child_process'

const url = process.env.APP_URL || 'http://localhost:5173'
execSync(`open -a "Firefox" "${url}"`)
