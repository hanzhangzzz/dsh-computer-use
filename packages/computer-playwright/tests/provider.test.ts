/**
 * Real-composition provider test: mounts the computer Service Definition and
 * the Playwright provider through a plain Cordis Context, then drives a real
 * headless Chrome through the full tracer-bullet sequence — navigate,
 * snapshot, click by index, screenshot. No mocks: this proves the seam and
 * the provider against the actual browser.
 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime from 'dsh-computer'
import * as computerPlaywright from '../src/index.ts'

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ComputerRuntime)
  await ctx.plugin(computerPlaywright, {})
  return ctx
}

describe('computer-playwright provider over ctx.computer', () => {
  test('navigate → snapshot → click → screenshot on example.com', async () => {
    const ctx = await mounted()
      const nav = await ctx.computer.navigate('https://example.com')
      expect(nav.url).toBe('https://example.com/')
      expect(nav.title).toBe('Example Domain')

      const snap = await ctx.computer.snapshot()
      expect(snap.url).toBe('https://example.com/')
      expect(snap.elements.length).toBeGreaterThanOrEqual(1)
      // example.com's only interactive element is its link; the snapshot
      // must expose it with a stable index and a recognizable name.
      const link = snap.elements.find(el => el.role === 'link')
      expect(link).toBeDefined()
      expect(link?.index).toBeGreaterThanOrEqual(0)
      expect(link?.name.toLowerCase()).toContain('more')

      const click = await ctx.computer.click(link!.index)
      expect(click.clicked).toContain('link')
      expect(click.url).toContain('iana.org')

      const shot = await ctx.computer.screenshot()
      expect(shot.mediaType).toBe('image/png')
      expect(shot.width).toBe(1280)
      expect(shot.height).toBe(800)
      // PNG magic bytes.
      expect(shot.data[0]).toBe(0x89)
      expect(shot.data[1]).toBe(0x50)
      expect(shot.data.byteLength).toBeGreaterThan(1000)

      // Unchanged-page detection: after landing, a repeat snapshot with no
      // navigation collapses to a light unchanged marker.
      const before = await ctx.computer.snapshot()
      expect(before.unchangedSince).toBeUndefined()
      const after = await ctx.computer.snapshot()
      expect(after.unchangedSince).toBe(2)
      expect(after.elements).toEqual([])
      // Context teardown follows main-repo test convention: the vitest process
      // owns the lifetime; Chrome exits with its stdio pipe.
      void ctx
  })
})
