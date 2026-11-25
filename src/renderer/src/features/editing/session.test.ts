import { describe, expect, it } from 'vitest'
import type { DiffStatus, FileDiff } from '@shared/ipc/review'
import type { EditorChange } from '@shared/review/edit-mapping'
import { computeHunks } from '@shared/review/hunks'
import { EditSession, type TextDiff } from './session'

// 편집 세션(SPEC 4장): 편집 투명 규칙, 저장 안 된 편집, 조용히 다시 불러오기, 충돌, 내 편집 유지.

function textDiff(
  baselineText: string,
  currentText: string,
  currentHash = 'h1',
  status?: DiffStatus
): TextDiff {
  const hunks = computeHunks(baselineText, currentText)
  return {
    projectId: 'p',
    path: 'a.ts',
    kind: 'text',
    // 기본값: 빈 기준선은 새 파일
    status: status ?? (baselineText === '' ? 'added' : hunks.length > 0 ? 'modified' : 'clean'),
    baselineText,
    currentText,
    currentHash,
    hunks
  }
}

function insert(line: number, column: number, text: string): EditorChange {
  return {
    range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
    text
  }
}

const OPTIONS = { showOwnEditsAsDiff: false }
const BASE = 'a\nb\nc\nd\n'
const CUR = 'a\nB\nc\nd\n'

describe('EditSession', () => {
  it('hunk 밖 편집은 메모리 기준선도 따라가 diff가 그대로고, 저장할 때 기준선을 함께 보낸다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    expect(session.dirty).toBe(false)
    session.applyChanges([insert(4, 2, '!')], OPTIONS)
    expect(session.dirty).toBe(true)
    expect(session.hunks).toHaveLength(1)
    expect(session.savePayload()).toEqual({
      text: 'a\nB\nc\nd!\n',
      baseline: 'a\nb\nc\nd!\n',
      diskHash: 'h1',
      overwrite: false
    })
  })

  it('hunk 안 편집은 기준선을 그대로 두고 저장할 때 기준선을 보내지 않는다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(2, 2, '?')], OPTIONS)
    expect(session.baseline).toBe(BASE)
    expect(session.savePayload().baseline).toBeNull()
  })

  it('"내 편집도 diff로 보기"와 새 파일(빈 기준선)에서는 기준선을 건드리지 않는다', () => {
    const own = new EditSession(textDiff(BASE, CUR))
    own.applyChanges([insert(4, 2, '!')], { showOwnEditsAsDiff: true })
    expect(own.baseline).toBe(BASE)
    expect(own.hunks).toHaveLength(2)

    const fresh = new EditSession(textDiff('', 'x\n'))
    fresh.applyChanges([insert(1, 1, 'top\n')], OPTIONS)
    expect(fresh.baseline).toBe('')
    expect(fresh.savePayload().baseline).toBeNull()
  })

  it('기준선이 빈 내용인 기존 파일은 편집 투명 규칙을 쓴다(기준선 없는 새 파일만 뺀다)', () => {
    const empty = new EditSession(textDiff('', '', 'h1', 'clean'))
    empty.applyChanges([insert(1, 1, 'x = 1\n')], OPTIONS)
    expect(empty.hunks).toEqual([])
    expect(empty.savePayload().baseline).toBe('x = 1\n')

    // 빈 새 파일을 확인하면 기준선 글은 ''그대로지만 "없음"에서 "빈 내용"이 된다
    const fresh = new EditSession(textDiff('', '', 'h1', 'added'))
    fresh.applyChanges([insert(1, 1, 'y\n')], OPTIONS)
    expect(fresh.hunks).toHaveLength(1)
    fresh.discard()
    expect(fresh.reconcile(textDiff('', '', 'h1', 'clean'))).toBe('refresh')
    fresh.applyChanges([insert(1, 1, 'y\n')], OPTIONS)
    expect(fresh.hunks).toEqual([])
    expect(fresh.savePayload().baseline).toBe('y\n')
  })

  it('되돌려서 디스크 내용으로 돌아오면 저장 안 된 편집도, 기준선 차이도 없다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(4, 2, '!')], OPTIONS)
    session.applyChanges(
      [
        {
          range: { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 3 },
          text: ''
        }
      ],
      OPTIONS
    )
    expect(session.dirty).toBe(false)
    expect(session.baseline).toBe(BASE)
  })

  it('저장 안 된 편집이 없으면 디스크 변경을 조용히 다시 불러온다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    expect(session.reconcile(textDiff(BASE, CUR))).toBe('same')
    expect(session.reconcile(textDiff(BASE, 'a\nB\nc\nd\ne\n', 'h2'))).toBe('reload')
    expect(session.buffer).toBe('a\nB\nc\nd\ne\n')
    // 기준선만 바뀌면(확인) 버퍼는 그대로 다시 그린다
    expect(session.reconcile(textDiff('a\nB\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'h2'))).toBe('refresh')
    expect(session.hunks).toEqual([])
  })

  it('편집 중 디스크가 바뀌면 충돌로 남기고 버퍼는 지킨다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(1, 2, ' mine')], OPTIONS)
    const theirs = textDiff(BASE, 'a\nB\nc\nd\ntheirs\n', 'h2')
    expect(session.reconcile(theirs)).toBe('conflict')
    expect(session.conflict).toBe(theirs)
    expect(session.buffer).toBe('a mine\nB\nc\nd\n')
    // 디스크가 원래대로 돌아오면 충돌도 풀린다
    expect(session.reconcile(textDiff(BASE, CUR, 'h1'))).toBe('refresh')
    expect(session.conflict).toBeNull()
  })

  it('"내 편집 유지": 새 디스크 해시로 덮어쓰기 저장, 백업 요청', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(4, 2, '!')], OPTIONS)
    session.reconcile(textDiff(BASE, 'theirs\n', 'h2'))
    session.keepMine()
    expect(session.conflict).toBeNull()
    expect(session.dirty).toBe(true)
    expect(session.savePayload()).toMatchObject({
      text: 'a\nB\nc\nd!\n',
      baseline: 'a\nb\nc\nd!\n',
      diskHash: 'h2',
      overwrite: true
    })
  })

  it('지워진 파일과 충돌한 뒤 "내 편집 유지"면 다시 만들고, "디스크 버전"이면 세션을 닫는다', () => {
    const deleted: FileDiff = {
      ...textDiff(BASE, ''),
      kind: 'deleted',
      status: 'deleted',
      currentHash: 'missing'
    }
    const keep = new EditSession(textDiff(BASE, CUR))
    keep.applyChanges([insert(1, 1, '>')], OPTIONS)
    keep.markConflict(deleted)
    keep.keepMine()
    expect(keep.savePayload()).toMatchObject({ diskHash: 'missing', overwrite: true })

    const drop = new EditSession(textDiff(BASE, CUR))
    drop.applyChanges([insert(1, 1, '>')], OPTIONS)
    drop.markConflict(deleted)
    expect(drop.discard()).toBe(false)
  })

  it('"디스크 버전 불러오기"는 충돌한 디스크 내용으로 돌아간다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(4, 2, '!')], OPTIONS)
    session.reconcile(textDiff(BASE, 'x\n', 'h2'))
    expect(session.discard()).toBe(true)
    expect(session.buffer).toBe('x\n')
    expect(session.dirty).toBe(false)
    expect(session.diskHash).toBe('h2')
  })

  it('저장 뒤: 보내는 동안 친 글자만 남고, 영속화한 기준선이 새 바탕이다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(4, 2, '!')], OPTIONS)
    const sent = session.savePayload()
    // 응답을 기다리는 동안 더 친다(hunk 밖)
    session.applyChanges([insert(1, 2, '#')], OPTIONS)
    const result = textDiff(sent.baseline ?? '', sent.text, 'h-saved')
    expect(session.saved(sent, 'h-saved', result)).toBe('same')
    expect(session.dirty).toBe(true)
    expect(session.savePayload()).toEqual({
      text: 'a#\nB\nc\nd!\n',
      baseline: 'a#\nb\nc\nd!\n',
      diskHash: 'h-saved',
      overwrite: false
    })
  })

  it('저장 직후 다른 곳이 또 쓰면 충돌이다', () => {
    const session = new EditSession(textDiff(BASE, CUR))
    session.applyChanges([insert(2, 2, '?')], OPTIONS)
    const sent = session.savePayload()
    session.applyChanges([insert(1, 2, '#')], OPTIONS)
    expect(session.saved(sent, 'h-saved', textDiff(BASE, 'other\n', 'h3'))).toBe('conflict')
  })

  it('삭제 줄 zone용 기준선 줄은 줄 끝 문자를 뺀다', () => {
    const session = new EditSession(textDiff('x\r\ny\n', 'y\n'))
    expect(session.baselineLines()).toEqual(['x', 'y'])
    expect(session.baselineLines()).toBe(session.baselineLines())
  })
})
