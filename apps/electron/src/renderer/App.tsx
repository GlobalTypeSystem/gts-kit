import { SharedApp } from '../../../web/src/components/SharedApp'
import { useJsonObjsWithScanner } from '../../../web/src/hooks/useJsonFiles'
import { ElectronScanner } from '../../../../packages/fs-adapters/fs-adapter-electron/src/index'

function App() {
  const model = useJsonObjsWithScanner(() => new ElectronScanner())

  return (
    <SharedApp
      model={model}
      directorySelectionText="Choose a directory containing JSON files (and optional schemas). Files are scanned using Electron's filesystem access."
    />
  )
}

export default App
