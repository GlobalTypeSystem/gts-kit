// Debug logging utilities
// Logs are only active in development mode

const DEBUG = process.env.NODE_ENV === 'development'

export const debug = {
  diagram: (...args: any[]) => DEBUG && console.log('[Diagram]', ...args),
  node: (...args: any[]) => DEBUG && console.log('[Node]', ...args),
  edge: (...args: any[]) => DEBUG && console.log('[Edge]', ...args),
  refresh: (...args: any[]) => DEBUG && console.log('[Refresh]', ...args),
  layout: (...args: any[]) => DEBUG && console.log('[Layout]', ...args),
  files: (...args: any[]) => DEBUG && console.log('[Files]', ...args),
  viewport: (...args: any[]) => DEBUG && console.log('[Viewport]', ...args),
}
