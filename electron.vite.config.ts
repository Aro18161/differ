import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * 렌더러 index.html에 CSP를 넣는다.
 * 개발 서버에서는 React Refresh가 넣는 인라인 preamble 하나만 해시로 허용하고,
 * 빌드 결과물에는 인라인 스크립트를 전혀 허용하지 않는다.
 */
function contentSecurityPolicy(): Plugin {
  let scriptSrc = "'self'"
  return {
    name: 'differ:csp',
    configResolved(config) {
      if (config.command !== 'serve') return
      const preamble = react.preambleCode.replace('__BASE__', config.base)
      const hash = createHash('sha256').update(preamble).digest('base64')
      scriptSrc = `'self' 'sha256-${hash}'`
    },
    transformIndexHtml() {
      const policy = [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
      ].join('; ')
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias }
  },
  preload: {
    resolve: { alias: sharedAlias },
    // sandbox 렌더러의 preload는 electron 말고는 require할 수 없으므로 의존성을 모두 번들한다.
    build: { externalizeDeps: false }
  },
  renderer: {
    resolve: {
      alias: { ...sharedAlias, '@': resolve('src/renderer/src') }
    },
    plugins: [contentSecurityPolicy(), react(), tailwindcss()]
  }
})
