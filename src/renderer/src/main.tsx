import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './assets/main.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root 요소를 찾지 못했습니다')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
