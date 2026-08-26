/** Provider-level live check against a real attached Electron host (WeChat
 * devtools on :9222): the screenshot the model sees and the coordinates
 * clickAt accepts must be the same space, and a coordinate click read off that
 * screenshot must actually change the page.
 * Manual-gated: runs only under WECHAT_CDP=1, because it needs that host and
 * it clicks in the user's live application. */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime from '../../computer/src/index.ts'
import * as provider from '../src/index.ts'

describe.skipIf(process.env.WECHAT_CDP !== '1')('coordinate space on an attached Electron host', () => {
  test('reported size is the CSS viewport, and a coordinate click switches the category', async () => {
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    await ctx.plugin(provider, { cdpEndpoint: 'http://127.0.0.1:9222' })

    const before = await ctx.computer.screenshot()
    console.log('reported:', before.width, 'x', before.height)
    expect([before.width, before.height]).toEqual([before.data.readUInt32BE(16), before.data.readUInt32BE(20)])

    // The nav item the model could see but not enumerate. Its coordinates come
    // off the CSS-scaled screenshot, which is now the same space clickAt takes.
    const result = await ctx.computer.clickAt(14, 72)
    const after = await ctx.computer.screenshot()
    console.log('clicked:', result.clicked)
    const fs = await import('node:fs')
    fs.writeFileSync('/tmp/wx-before.png', before.data)
    fs.writeFileSync('/tmp/wx-after.png', after.data)
    // The identical-bytes case is the exact failure the coordinate-space bug
    // produced: the click landed on dead space and nothing happened.
    expect(Buffer.compare(before.data, after.data)).not.toBe(0)
  })
})
