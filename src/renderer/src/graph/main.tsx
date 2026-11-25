import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/base.css'
import '../assets/main.css'
import './graph.css'
import { GraphApp } from './GraphApp'

// 연관 그래프 창(⌘G)의 진입점. 색 토큰은 메인 창과 같은 main.css를 쓰고, 그래프 전용 모양은 graph.css에 둔다.

const root = document.getElementById('root')
if (!root) throw new Error('#root 요소를 찾지 못했습니다')

createRoot(root).render(
  <StrictMode>
    <GraphApp />
  </StrictMode>
)
