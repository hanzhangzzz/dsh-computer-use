/**
 * Real-composition provider test: mounts the computer Service Definition and
 * the Playwright provider through a plain Cordis Context, then drives a real
 * headless Chrome through the full tracer-bullet sequence — navigate,
 * snapshot, click by index, screenshot. No mocks: this proves the seam and
 * the provider against the actual browser.
 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime from '../../computer/src/index.ts'
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
      // The click embeds its post-click snapshot as the next baseline.
      expect(click.after.url).toContain('iana.org')
      expect(click.after.unchangedSince).toBeUndefined()
      expect(click.after.elements.length).toBeGreaterThanOrEqual(1)

      const shot = await ctx.computer.screenshot()
      expect(shot.mediaType).toBe('image/png')
      expect(shot.width).toBe(1280)
      expect(shot.height).toBe(800)
      // PNG magic bytes.
      expect(shot.data[0]).toBe(0x89)
      expect(shot.data[1]).toBe(0x50)
      expect(shot.data.byteLength).toBeGreaterThan(1000)

      // Unchanged-page detection: the click's embedded snapshot is the new
      // baseline (seq 2 on the IANA page), so repeat snapshots collapse to a
      // light unchanged marker pointing at it.
      const before = await ctx.computer.snapshot()
      expect(before.unchangedSince).toBe(2)
      const after = await ctx.computer.snapshot()
      expect(after.unchangedSince).toBe(2)
      expect(after.elements).toEqual([])
      // Context teardown follows main-repo test convention: the vitest process
      // owns the lifetime; Chrome exits with its stdio pipe.
      void ctx
  })

  test('type fills a form textbox and reflects the value in the next snapshot', async () => {
    const ctx = await mounted()
    await ctx.computer.navigate('https://httpbin.org/forms/post')
    const snap = await ctx.computer.snapshot()
    const box = snap.elements.find(el => el.role === 'textbox')
    expect(box).toBeDefined()
    const typed = await ctx.computer.type(box!.index, 'Alice Zhang')
    expect(typed.filled).toContain('textbox')
    expect(typed.text).toBe('Alice Zhang')
    // The post-input snapshot reflects the value through the element name.
    const reflected = typed.after.elements.find(el => el.index === box!.index)
    expect(reflected?.name).toContain('Alice Zhang')
  })
})

describe('attach detach semantics (0.3.2 guard)', () => {
  test('a disconnected attachment makes every later call fail with restart guidance', async () => {
    // A plain headless Chrome standing in for any attached Electron app.
    const { chromium } = await import('playwright-core')
    const host = await chromium.launch({ channel: 'chrome', headless: true, args: ['--remote-debugging-port=9223'] })
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    await ctx.plugin(computerPlaywright, { cdpEndpoint: 'http://127.0.0.1:9223' })
    // Attached and working.
    const snap = await ctx.computer.snapshot()
    expect(snap.elements).toBeDefined()

    // The host app goes away on its own terms.
    await host.close()
    await new Promise(resolve => setTimeout(resolve, 500))

    await expect(ctx.computer.snapshot()).rejects.toThrow(/do not restart the application yourself/)
    await expect(ctx.computer.click(0)).rejects.toThrow(/has disconnected/)
    await expect(ctx.computer.screenshot()).rejects.toThrow(/report this to the user/)
  })
})
