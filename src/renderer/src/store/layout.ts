import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { clampSidebarWidth, SIDEBAR_WIDTH } from '@/lib/sidebar-width'

type LayoutState = {
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  resetSidebarWidth: () => void
}

// 화면 배치만 담는 렌더러 상태. 앱 설정(settings.json)과 달리 이 창의 localStorage에 남긴다.
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR_WIDTH.default,
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH.default })
    }),
    {
      name: 'differ.layout',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sidebarWidth: state.sidebarWidth }),
      // 저장된 값이 깨졌거나 범위를 벗어나도 허용 범위 안으로 되돌린다.
      merge: (persisted, current) => ({
        ...current,
        sidebarWidth: clampSidebarWidth(
          (persisted as { sidebarWidth?: unknown } | undefined)?.sidebarWidth
        )
      })
    }
  )
)
