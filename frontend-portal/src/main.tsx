import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Aplica modo (light/dark) e accent salvos ANTES do 1º render, evitando "flash"
// de tema errado e mantendo o atributo consistente independentemente de qual
// componente monta o hook useTheme primeiro.
;(() => {
  try {
    const mode = localStorage.getItem('dealernet-portal-theme')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const theme = mode === 'light' || mode === 'dark' ? mode : prefersDark ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
  } catch {
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
