/** 사이드바 너비 규칙 (SPEC 3장: 기본 260px, 200–420px 드래그 조절). */
export const SIDEBAR_WIDTH = { min: 200, max: 420, default: 260 } as const

/** 허용 범위 안의 정수 너비로 맞춘다. 숫자가 아니면 기본값을 쓴다. */
export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_WIDTH.default
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))
}
