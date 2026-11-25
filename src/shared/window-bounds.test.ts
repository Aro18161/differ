import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  parseSavedWindowState,
  resolveInitialBounds,
  type Rect
} from './window-bounds'

const laptop: Rect = { x: 0, y: 25, width: 1512, height: 920 }
const externalRight: Rect = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('parseSavedWindowState', () => {
  it('정상 값은 정수로 반올림하고 maximized 기본값은 false', () => {
    expect(parseSavedWindowState({ x: 10.4, y: 20.6, width: 1000, height: 700 })).toEqual({
      x: 10,
      y: 21,
      width: 1000,
      height: 700,
      maximized: false
    })
    expect(
      parseSavedWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: true })?.maximized
    ).toBe(true)
  })

  it('모양이 틀린 값은 null', () => {
    expect(parseSavedWindowState(null)).toBeNull()
    expect(parseSavedWindowState('1,2,3,4')).toBeNull()
    expect(parseSavedWindowState({ x: '1', y: 0, width: 1000, height: 700 })).toBeNull()
    expect(parseSavedWindowState({ x: 0, y: 0, width: Number.NaN, height: 700 })).toBeNull()
    expect(parseSavedWindowState({ x: 0, y: 0, width: 0, height: 700 })).toBeNull()
  })
})

describe('resolveInitialBounds', () => {
  it('저장된 값이 없으면 기본 크기로 가운데에 연다', () => {
    expect(resolveInitialBounds(null, [laptop])).toEqual({
      ...DEFAULT_WINDOW_SIZE,
      maximized: false,
      position: null
    })
  })

  it('화면 안에 있던 창은 그대로 복원한다', () => {
    const saved = { x: 100, y: 80, width: 1100, height: 700, maximized: false }
    expect(resolveInitialBounds(saved, [laptop])).toEqual({
      width: 1100,
      height: 700,
      maximized: false,
      position: { x: 100, y: 80 }
    })
  })

  it('외부 모니터에 있던 창은 그 모니터가 연결돼 있으면 그 위치로 연다', () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000, maximized: false }
    expect(resolveInitialBounds(saved, [laptop, externalRight]).position).toEqual({
      x: 2000,
      y: 100
    })
  })

  it('모니터를 뺐으면 위치는 버리고 주 화면에 맞게 크기를 줄인다', () => {
    const saved = { x: 2000, y: 100, width: 2400, height: 1300, maximized: true }
    expect(resolveInitialBounds(saved, [laptop])).toEqual({
      width: laptop.width,
      height: laptop.height,
      maximized: true,
      position: null
    })
  })

  it('최소 크기보다 작게 저장된 값은 최소 크기로 올린다', () => {
    const saved = { x: 100, y: 80, width: 300, height: 200, maximized: false }
    const result = resolveInitialBounds(saved, [laptop])
    expect(result.width).toBe(MIN_WINDOW_SIZE.width)
    expect(result.height).toBe(MIN_WINDOW_SIZE.height)
  })

  it('위쪽 드래그 영역이 조금밖에 안 보이면 위치를 버린다', () => {
    const almostOffLeft = { x: -1050, y: 80, width: 1100, height: 700, maximized: false }
    expect(resolveInitialBounds(almostOffLeft, [laptop]).position).toBeNull()
    const titleAboveScreen = { x: 100, y: -400, width: 1100, height: 700, maximized: false }
    expect(resolveInitialBounds(titleAboveScreen, [laptop]).position).toBeNull()
  })
})
