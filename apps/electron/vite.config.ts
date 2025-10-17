import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
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
      external: [],
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 3001,
    strictPort: true,
  },
})
