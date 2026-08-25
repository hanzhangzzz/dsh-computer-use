/**
 * Pure-function tests for the model-facing render and arg-parsing helpers.
 * These pin the exact model-visible text of every tool outcome (full snapshot,
 * unchanged collapse, click/type/key renders) and the rejection paths of the
 * arg parsers — no browser needed, so regressions surface here instead of in
 * live model runs.
 */
import { describe, expect, test } from 'vitest'
import {
  formatClick,
  formatKeyPress,
  formatSnapshot,
  formatType,
  parseClickArgs,
  parseKeyPressArgs,
  parseNavigateArgs,
  parseTypeArgs,
} from '../src/index.ts'

const fullSnapshot = {
  url: 'https://example.com/',
  title: 'Example Domain',
  elements: [
    { index: 0, role: 'link', name: 'More information...' },
    { index: 1, role: 'textbox', name: '' },
  ],
}

const unchangedSnapshot = {
  url: 'https://example.com/',
  title: 'Example Domain',
  elements: [],
  unchangedSince: 2,
}

describe('formatSnapshot', () => {
  test('renders title, url, and indexed elements', () => {
    expect(formatSnapshot(fullSnapshot)).toBe(
      '# Example Domain\nhttps://example.com/\n\n0: link "More information..."\n1: textbox',
    )
  })
  test('renders the unchanged collapse with its validity guarantee', () => {
    const text = formatSnapshot(unchangedSnapshot)
    expect(text).toContain('unchanged since snapshot #2')
    expect(text).toContain('indices from that snapshot remain valid')
  })
})

describe('formatClick / formatType / formatKeyPress', () => {
  test('click embeds the full post-click view', () => {
    const text = formatClick({ clicked: 'link "More information..."', url: 'https://iana.org/', after: fullSnapshot })
    expect(text).toContain('clicked link "More information..."')
    expect(text).toContain('now at https://iana.org/')
    expect(text).toContain('0: link "More information..."')
  })
  test('click against an unchanged page reports index validity instead', () => {
    const text = formatClick({ clicked: 'button "Menu"', url: 'https://example.com/', after: unchangedSnapshot })
    expect(text).toContain('unchanged since snapshot #2')
    expect(text).toContain('prior indices remain valid')
  })
  test('type reports the filled text and the post-input view', () => {
    const text = formatType({ filled: 'textbox "Search"', text: 'DeepSeek', after: fullSnapshot })
    expect(text).toContain('filled textbox "Search" with "DeepSeek"')
    expect(text).toContain('1: textbox')
  })
  test('key press reports the key and the post-press view', () => {
    const text = formatKeyPress({ key: 'Enter', after: unchangedSnapshot })
    expect(text).toContain('pressed Enter')
    expect(text).toContain('unchanged since snapshot #2')
  })
})

describe('arg parsers reject invalid input', () => {
  test('navigate requires an http(s) url', () => {
    expect(() => parseNavigateArgs({ url: 'ftp://x' })).toThrow(/http\(s\) URL/)
    expect(() => parseNavigateArgs({ url: 42 })).toThrow(/http\(s\) URL/)
    expect(parseNavigateArgs({ url: 'https://x' })).toEqual({ url: 'https://x' })
  })
  test('click requires a non-negative integer index', () => {
    expect(() => parseClickArgs({ index: -1 })).toThrow(/non-negative integer/)
    expect(() => parseClickArgs({ index: 1.5 })).toThrow(/non-negative integer/)
    expect(() => parseClickArgs({ index: '0' })).toThrow(/non-negative integer/)
    expect(parseClickArgs({ index: 0 })).toEqual({ index: 0 })
  })
  test('type requires a valid index and a string text', () => {
    expect(() => parseTypeArgs({ index: 0, text: 7 })).toThrow(/text must be a string/)
    expect(parseTypeArgs({ index: 3, text: 'hi' })).toEqual({ index: 3, text: 'hi' })
  })
  test('press requires a short non-empty key', () => {
    expect(() => parseKeyPressArgs({ key: '' })).toThrow(/short non-empty string/)
    expect(() => parseKeyPressArgs({ key: 'x'.repeat(33) })).toThrow(/short non-empty string/)
    expect(parseKeyPressArgs({ key: 'Enter' })).toEqual({ key: 'Enter' })
  })
})
