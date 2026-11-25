import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

// shadcn/ui sonner. 앱은 항상 다크라 next-themes 없이 dark로 고정한다.
// 등장·퇴장 모션은 main.css에서 끈다(SPEC 7장: 모션은 체크 페이드와 목록 재정렬뿐).

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-center"
      duration={2400}
      visibleToasts={3}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)'
        } as CSSProperties
      }
      toastOptions={{ classNames: { toast: 'differ-toast' } }}
      {...props}
    />
  )
}

export { Toaster }
