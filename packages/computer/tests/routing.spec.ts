/**
 * Multi-surface routing: the change that lets a browser provider and a desktop
 * provider be mounted at the same time. Before it, two usable providers made
 * every call raise COMPUTER_PROVIDER_AMBIGUOUS, which is why the desktop track
 * could not start. These tests pin the property that replaced it — routing is a
 * pure function of the surface id, never of registration order.
 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime from '../src/index.ts'
import type {
  ComputerClickResult,
  ComputerKeyPressResult,
  ComputerNavigation,
  ComputerProvider,
  ComputerScreenshot,
  ComputerSnapshot,
  ComputerSurface,
  ComputerTypeResult,
} from '../src/index.ts'

/** A provider that records which surface it was told to act on. */
function fakeProvider(id: string, locals: readonly string[]): ComputerProvider & { acted: string[] } {
  const surfaces = locals.map(local => ({
    id: `${id}:${local}`,
    kind: id === 'macos' ? 'app' as const : 'browser' as const,
    title: `${id} ${local}`,
    locator: local,
  }))
  let focused = surfaces[0]?.id ?? ''
  const acted: string[] = []
  const snapshot = async (): Promise<ComputerSnapshot> => {
    acted.push(focused)
    return { url: focused, title: focused, elements: [] }
  }
  return {
    id,
    acted,
    available: () => true,
    surfaces: async () => surfaces,
    focus: async (surfaceId: string): Promise<ComputerSurface> => {
      const hit = surfaces.find(s => s.id === surfaceId)
      if (hit === undefined) throw new Error(`unknown surface ${surfaceId}`)
      focused = surfaceId
      return hit
    },
    snapshot,
    navigate: async (): Promise<ComputerNavigation> => ({ url: focused, title: focused }),
    click: async (): Promise<ComputerClickResult> => ({ clicked: focused, url: focused, after: await snapshot() }),
    clickAt: async (): Promise<ComputerClickResult> => ({ clicked: focused, url: focused, after: await snapshot() }),
    type: async (): Promise<ComputerTypeResult> => ({ filled: focused, text: '', after: await snapshot() }),
    pressKey: async (): Promise<ComputerKeyPressResult> => ({ key: '', after: await snapshot() }),
    screenshot: async (): Promise<ComputerScreenshot> => ({
      data: new Uint8Array(), mediaType: 'image/png', width: 0, height: 0,
    }),
    close: async () => {},
  }
}

async function runtimeWith(...providers: ComputerProvider[]): Promise<ComputerRuntime> {
  const ctx = new Context()
  await ctx.plugin(ComputerRuntime)
  const seam = ctx.get('computer') as ComputerRuntime
  for (const provider of providers) seam.registerProvider(provider)
  return seam
}

describe('multi-surface routing', () => {
  test('surfaces aggregates across providers in a registration-order-free order', async () => {
    const browser = fakeProvider('playwright', ['page'])
    const desktop = fakeProvider('macos', ['com.apple.finder', 'com.apple.calculator'])

    const forward = await runtimeWith(browser, desktop)
    const backward = await runtimeWith(fakeProvider('macos', ['com.apple.finder', 'com.apple.calculator']), fakeProvider('playwright', ['page']))

    const ids = async (seam: ComputerRuntime) => (await seam.surfaces()).map(s => s.id)
    expect(await ids(forward)).toEqual([
      'macos:com.apple.calculator',
      'macos:com.apple.finder',
      'playwright:page',
    ])
    // The whole point: swapping registration order changes nothing.
    expect(await ids(backward)).toEqual(await ids(forward))
  })

  test('two usable providers are ambiguous until one surface is focused', async () => {
    const seam = await runtimeWith(fakeProvider('playwright', ['page']), fakeProvider('macos', ['com.apple.finder']))

    await expect(seam.snapshot()).rejects.toThrow(/multiple usable computer providers/)

    await seam.focus('macos:com.apple.finder')
    const snap = await seam.snapshot()
    expect(snap.url).toBe('macos:com.apple.finder')
    expect(seam.focusedSurface).toBe('macos:com.apple.finder')
  })

  test('actions follow the focused surface across providers', async () => {
    const browser = fakeProvider('playwright', ['page'])
    const desktop = fakeProvider('macos', ['com.apple.finder', 'com.apple.calculator'])
    const seam = await runtimeWith(browser, desktop)

    await seam.focus('playwright:page')
    await seam.snapshot()
    await seam.focus('macos:com.apple.calculator')
    await seam.snapshot()
    await seam.focus('macos:com.apple.finder')
    await seam.snapshot()

    expect(browser.acted).toEqual(['playwright:page'])
    expect(desktop.acted).toEqual(['macos:com.apple.calculator', 'macos:com.apple.finder'])
  })

  test('an unroutable surface id names the problem instead of guessing', async () => {
    const seam = await runtimeWith(fakeProvider('playwright', ['page']))
    await expect(seam.focus('macos:com.apple.finder')).rejects.toThrow(/no computer provider owns surface/)
  })

  test('a single provider still works with no focus at all (unchanged behaviour)', async () => {
    const seam = await runtimeWith(fakeProvider('playwright', ['page']))
    const snap = await seam.snapshot()
    expect(snap.url).toBe('playwright:page')
    expect(seam.focusedSurface).toBeUndefined()
  })

  test('one provider failing to enumerate does not hide the others', async () => {
    const broken = fakeProvider('macos', ['com.apple.finder'])
    broken.surfaces = async () => { throw new Error('the application quit') }
    const seam = await runtimeWith(fakeProvider('playwright', ['page']), broken)

    expect((await seam.surfaces()).map(s => s.id)).toEqual(['playwright:page'])
  })
})
