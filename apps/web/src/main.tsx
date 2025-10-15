import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Initialize App API if not already set by platform (electron, vscode)
if (!window.__GTS_APP_API__) {
  window.__GTS_APP_API__ = {
    type: 'web',
    // Web version uses server storage (no override needed)
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
