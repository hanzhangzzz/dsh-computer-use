/**
 * The macOS provider end to end, through the seam, against a real application.
 *
 * Manual-gated because it drives whatever is running on the machine. Set
 * MACOS_TARGET to a bundle id (the WeChat devtools reports as
 * com.github.Electron) with that application open:
 *
 *     MACOS_TARGET=com.github.Electron npx vitest run packages/computer-macos
 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ComputerRuntime from '../../computer/src/index.ts'
import * as macos from '../src/index.ts'

const TARGET = process.env.MACOS_TARGET ?? ''
const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'dsh-computer-macos-helper')

async function seamWithProvider() {
  const ctx = new Context()
  await ctx.plugin(ComputerRuntime)
  await ctx.plugin(macos, { helperPath: HELPER })
  return ctx.get('computer') as ComputerRuntime
}

describe.skipIf(TARGET === '' || process.platform !== 'darwin')('macOS provider over ctx.computer', () => {
  test('lists applications, focuses one, and reads its window', async () => {
    const seam = await seamWithProvider()

    const surfaces = await seam.surfaces()
    expect(surfaces.length).toBeGreaterThan(0)
    expect(surfaces.every(s => s.id.startsWith('macos:'))).toBe(true)
    // The policy filters the listing, so nothing denied can even be seen.
    expect(surfaces.some(s => s.locator === 'com.apple.Terminal')).toBe(false)

    const focused = await seam.focus(`macos:${TARGET}`)
    expect(focused.kind).toBe('app')
    expect(focused.locator).toBe(TARGET)

    const snap = await seam.snapshot()
    expect(snap.url).toBe(`app:${TARGET}`)
    expect(snap.elements.length).toBeGreaterThan(0)
    // Geometry comes free from the accessibility tree and the browser side
    // does not have it yet; it is what lets a screenshot be mapped back to an
    // index later.
    expect(snap.elements.some(el => el.rect !== undefined)).toBe(true)
  }, 60_000)

  test('a repeated snapshot of an unchanged window collapses instead of repaying its cost', async () => {
    const seam = await seamWithProvider()
    await seam.focus(`macos:${TARGET}`)
    await seam.snapshot()
    const again = await seam.snapshot()
    expect(again.unchangedSince).toBeDefined()
    expect(again.elements).toEqual([])
  }, 60_000)

  test('a denied application cannot be focused, and the refusal explains itself', async () => {
    const seam = await seamWithProvider()
    await expect(seam.focus('macos:com.apple.Terminal')).rejects.toThrow(/arbitrary commands/)
  }, 30_000)

  test('coordinate clicking is refused with the reason, not silently unsupported', async () => {
    const seam = await seamWithProvider()
    await seam.focus(`macos:${TARGET}`)
    await expect(seam.clickAt(10, 10)).rejects.toThrow(/address elements by their computer_snapshot index/)
  }, 30_000)
})
