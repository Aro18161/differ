import { describe, expect, it } from 'vitest'
import {
  addRecentPrompt,
  loadRecentPrompts,
  RECENT_PROMPT_LIMIT,
  rememberPrompt,
  stepHistory,
  type PromptStorage
} from './recent-prompts'

// ⌘K 입력창 ↑: 이 프로젝트의 최근 프롬프트 20개(SPEC 4장)

function memoryStorage(): PromptStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

describe('addRecentPrompt', () => {
  it('최근 것을 맨 앞에 두고, 같은 글은 앞으로 옮기고, 빈 글은 넣지 않는다', () => {
    expect(addRecentPrompt([], ' 에러 처리 추가 ')).toEqual(['에러 처리 추가'])
    expect(addRecentPrompt(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(addRecentPrompt(['a'], '   ')).toEqual(['a'])
  })

  it(`${RECENT_PROMPT_LIMIT}개만 남긴다`, () => {
    let list: string[] = []
    for (let i = 0; i < 30; i++) list = addRecentPrompt(list, `p${i}`)
    expect(list).toHaveLength(RECENT_PROMPT_LIMIT)
    expect(list[0]).toBe('p29')
    expect(list.at(-1)).toBe('p10')
  })
})

describe('저장', () => {
  it('프로젝트마다 따로 저장하고 다시 읽는다', () => {
    const storage = memoryStorage()
    rememberPrompt(storage, 'p1', '하나')
    rememberPrompt(storage, 'p1', '둘')
    rememberPrompt(storage, 'p2', '다른 프로젝트')
    expect(loadRecentPrompts(storage, 'p1')).toEqual(['둘', '하나'])
    expect(loadRecentPrompts(storage, 'p2')).toEqual(['다른 프로젝트'])
    expect(loadRecentPrompts(storage, 'p3')).toEqual([])
  })

  it('깨진 값은 빈 목록으로 읽고, 저장소가 없거나 쓰기가 실패해도 목록은 돌려준다', () => {
    const storage = memoryStorage()
    storage.data.set('differ:inline-prompts:p1', '{oops')
    expect(loadRecentPrompts(storage, 'p1')).toEqual([])
    storage.data.set('differ:inline-prompts:p1', JSON.stringify(['ok', 3, '', null]))
    expect(loadRecentPrompts(storage, 'p1')).toEqual(['ok'])
    expect(loadRecentPrompts(null, 'p1')).toEqual([])
    const full: PromptStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    }
    expect(rememberPrompt(full, 'p1', '그래도')).toEqual(['그래도'])
  })
})

describe('stepHistory', () => {
  it('↑는 더 오래된 것으로, ↓는 최근 쪽으로, 끝에서 멈춘다(-1은 쓰던 글)', () => {
    expect(stepHistory(3, -1, 'older')).toBe(0)
    expect(stepHistory(3, 0, 'older')).toBe(1)
    expect(stepHistory(3, 2, 'older')).toBe(2)
    expect(stepHistory(3, 1, 'newer')).toBe(0)
    expect(stepHistory(3, 0, 'newer')).toBe(-1)
    expect(stepHistory(3, -1, 'newer')).toBe(-1)
    expect(stepHistory(0, -1, 'older')).toBe(-1)
  })
})
