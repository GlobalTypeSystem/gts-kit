const { defineConfig } = require('vite')
const react = require('@vitejs/plugin-react')
const path = require('path')

// https://vitejs.dev/config/
module.exports = defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      // Map web app source so its internal "@/.." imports resolve when reusing components
      '@': path.resolve(__dirname, '../web/src'),
      '@electron': path.resolve(__dirname, './src/renderer'),
      '@gts-viewer/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@gts/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@gts/layout-storage': path.resolve(__dirname, '../../packages/layout-storage/src'),
    },
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      external: (id) => {
        // Externalize Node.js modules to prevent bundling
        return id.startsWith('node:') || id.includes('node_modules')
      },
    },
  },
  server: {
    port: 3001,
  },
})
