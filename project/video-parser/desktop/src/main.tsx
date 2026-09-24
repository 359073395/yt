import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './workbench.css'

async function mount() {
  const qa = import.meta.env.DEV && new URLSearchParams(window.location.search).has('qa')
  if (qa) {
    const { setupPreview } = await import('./qa-preview')
    setupPreview()
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
}
void mount()
