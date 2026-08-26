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
/** Inert controls to aim at: switching a category filter changes nothing. */
const SAFE_TARGETS = ['小程序', '小游戏', '多端应用', '代码片段', '公众号网页', '其他']

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

  test('the window\'s displayed content reaches the model, and a content change is not collapsed away', async () => {
    const seam = await seamWithProvider()
    await seam.focus(`macos:${TARGET}`)

    const first = await seam.snapshot()
    // Without this the model can press a calculator's keys and never read its
    // answer: enumeration returns controls only.
    expect(first.text).toBeDefined()
    expect(first.text!.length).toBeGreaterThan(0)

    // The critical case for the collapse. Pressing the same digit twice leaves
    // every control byte-identical while the readout changes, so a fingerprint
    // taken over elements alone reports "unchanged" at the moment the action
    // produced its result.
    const digit = first.elements.find(el => el.name === '7')
    if (digit === undefined) return // a different application
    // Read the post-click snapshot the click itself returns. Taking a separate
    // one would see a state nothing had changed since and collapse it, which
    // is the feature working, not the bug under test.
    const after = (await seam.click(digit.index)).after
    const later = (await seam.click(digit.index)).after

    expect(after.text).toBeDefined()
    expect(later.text).toBeDefined()
    expect(later.text).not.toEqual(after.text)
    expect(later.unchangedSince).toBeUndefined()
  }, 90_000)

  test('a denied application cannot be focused, and the refusal explains itself', async () => {
    const seam = await seamWithProvider()
    await expect(seam.focus('macos:com.apple.Terminal')).rejects.toThrow(/arbitrary commands/)
  }, 30_000)

  test('a coordinate resolves to a real element and reports which one', async () => {
    const seam = await seamWithProvider()
    await seam.focus(`macos:${TARGET}`)
    const snap = await seam.snapshot()
    // Aim at a category tab specifically. Picking "any named element" once
    // landed on the import link and opened a file dialog, which is exactly the
    // kind of side effect a test must not leave behind; switching a category
    // filter is inert.
    const tab = snap.elements.find(el => el.rect !== undefined && SAFE_TARGETS.includes(el.name))
    if (tab === undefined) return // a different application, or a different screen
    const rect = tab.rect!

    const result = await seam.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2)
    // The point is hit-tested rather than blindly clicked, so the outcome names
    // what it landed on -- the check a synthesised mouse event cannot offer.
    expect(result.clicked).toContain(tab.name)
  }, 60_000)

  test('a coordinate over nothing actionable is refused, not pressed anyway', async () => {
    const seam = await seamWithProvider()
    await seam.focus(`macos:${TARGET}`)
    await expect(seam.clickAt(2, 2)).rejects.toThrow(/exposes no action|nothing accessible/)
  }, 30_000)
})
