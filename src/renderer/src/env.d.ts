/// <reference types="vite/client" />
import type { DifferApi } from '@shared/api'

declare global {
  interface Window {
    differ: DifferApi
  }
}
