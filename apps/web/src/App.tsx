import { SharedApp } from './components/SharedApp'
import { useJsonObjs } from './hooks/useJsonFiles'
import { useJsonObjsVscode } from './hooks/useJsonFilesVscode'
import { getWebCapabilities } from '../../../packages/fs-adapters/fs-adapter-web/src/index'

function App() {
  // Detect if running in VSCode environment
  const appApi = (window as any).__GTS_APP_API__
  const isVSCode = appApi?.type === 'vscode'

  // Use appropriate hook based on environment
  const model = isVSCode ? useJsonObjsVscode() : useJsonObjs()

  // Provide browser-specific messaging
  const capabilities = getWebCapabilities()
  const directorySelectionText = capabilities.supportsRefresh
    ? "Choose a directory containing JSON files (and optional schemas). Files are scanned locally using your browser with full directory access."
    : "Choose a directory containing JSON files (and optional schemas). Files are scanned locally using your browser. Note: Firefox users will need to select individual files due to browser limitations."

  return (
    <SharedApp
      model={model}
      directorySelectionText={directorySelectionText}
      isVSCode={isVSCode}
    />
  )
}

export default App
