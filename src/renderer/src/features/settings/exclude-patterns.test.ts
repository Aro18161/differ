import { describe, expect, it } from 'vitest'
import { formatExcludePatterns, parseExcludePatterns, samePatterns } from './exclude-patterns'

describe('parseExcludePatterns', () => {
  it('한 줄에 하나, 공백·빈 줄·주석·중복을 뺀다', () => {
    expect(parseExcludePatterns('  *.log \n\n# 생성물\ngen/\r\n*.log\n')).toEqual(['*.log', 'gen/'])
  })

  it('format과 왕복한다', () => {
    const patterns = ['*.snap', 'fixtures/**']
    expect(parseExcludePatterns(formatExcludePatterns(patterns))).toEqual(patterns)
    expect(samePatterns(patterns, ['*.snap', 'fixtures/**'])).toBe(true)
    expect(samePatterns(patterns, ['fixtures/**', '*.snap'])).toBe(false)
  })
})
