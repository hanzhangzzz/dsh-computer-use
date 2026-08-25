/** Live CDP probe: attach to the WeChat devtools (Electron/Chromium) and take a structure-first snapshot. Manual-gated: runs only under WECHAT_CDP=1. */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime from '../../computer/src/index.ts'
import * as provider from '../src/index.ts'

describe.skipIf(process.env.WECHAT_CDP !== '1')('CDP attach to WeChat devtools', () => {
  test('snapshot enumerates the devtools DOM', async () => {
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    await ctx.plugin(provider, { cdpEndpoint: 'http://127.0.0.1:9222' })
    const snap = await ctx.computer.snapshot()
    console.log('url:', snap.url.slice(0, 80))
    console.log('title:', snap.title)
    console.log('elements:', snap.elements.length)
    for (const el of snap.elements.slice(0, 12)) console.log(` ${el.index}: ${el.role} "${el.name.slice(0, 50)}"`)
    expect(snap.elements.length).toBeGreaterThan(0)
  })
})
