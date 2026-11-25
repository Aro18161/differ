// 창 위치·크기 복원 규칙. main에서 쓰지만 Electron에 기대지 않는 순수 함수라 shared에 둔다.

export type Rect = { x: number; y: number; width: number; height: number }

export type SavedWindowState = Rect & { maximized: boolean }

export type InitialWindowBounds = {
  width: number
  height: number
  maximized: boolean
  /** null이면 위치를 정하지 않고 Electron 기본값(화면 가운데)에 맡긴다. */
  position: { x: number; y: number } | null
}

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const
export const MIN_WINDOW_SIZE = { width: 900, height: 560 } as const

/** 창을 다시 끌어 옮길 수 있으려면 위쪽 드래그 영역이 화면 안에 이만큼은 보여야 한다. */
const TITLE_BAR_HEIGHT = 36
const MIN_VISIBLE_TITLE_WIDTH = 120

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** settings.json에서 읽은 값을 검증한다. 모양이 틀리면 null. */
export function parseSavedWindowState(value: unknown): SavedWindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height, maximized } = value as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: maximized === true
  }
}

function titleBarVisibleIn(rect: Rect, area: Rect): boolean {
  const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const overlapY =
    Math.min(rect.y + TITLE_BAR_HEIGHT, area.y + area.height) - Math.max(rect.y, area.y)
  return overlapX >= MIN_VISIBLE_TITLE_WIDTH && overlapY >= TITLE_BAR_HEIGHT / 2
}

/**
 * 저장된 창 상태와 지금 연결된 화면들의 작업 영역으로 첫 창의 위치·크기를 정한다.
 * 저장된 위치가 어느 화면에서도 닿지 않으면(외부 모니터를 뺀 경우 등) 크기만 살리고
 * 주 화면에 들어가게 줄인 뒤 위치는 기본값에 맡긴다.
 */
export function resolveInitialBounds(
  saved: SavedWindowState | null,
  workAreas: readonly Rect[]
): InitialWindowBounds {
  if (!saved) return { ...DEFAULT_WINDOW_SIZE, maximized: false, position: null }

  const width = Math.max(saved.width, MIN_WINDOW_SIZE.width)
  const height = Math.max(saved.height, MIN_WINDOW_SIZE.height)
  const rect = { x: saved.x, y: saved.y, width, height }

  if (workAreas.some((area) => titleBarVisibleIn(rect, area))) {
    return { width, height, maximized: saved.maximized, position: { x: rect.x, y: rect.y } }
  }

  const primary = workAreas[0]
  return {
    width: primary ? Math.max(Math.min(width, primary.width), MIN_WINDOW_SIZE.width) : width,
    height: primary ? Math.max(Math.min(height, primary.height), MIN_WINDOW_SIZE.height) : height,
    maximized: saved.maximized,
    position: null
  }
}
