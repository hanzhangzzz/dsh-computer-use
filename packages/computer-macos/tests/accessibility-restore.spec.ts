/**
 * Does the helper put applications back the way it found them?
 *
 * Reading a Chromium application's tree requires switching it into full
 * accessibility mode, which is the optimisation Chromium relies on to stay
 * cheap: it builds no tree until it believes an assistive client is watching.
 * The flag survives the process that set it, so leaving it on hands the
 * application an unbounded cost — it maintains a full tree for nobody, for as
 * long as it runs, and nothing in its UI says why it got slower.
 *
 * A live machine reached load average 41 with a Chromium application pegged at
 * 410% CPU after a session that set this flag repeatedly and never cleared it.
 * That instance could not be proven to be the flag's doing — a freshly
 * launched one misbehaved the same way untouched — but "we cannot prove we
 * caused it" is not a reason to keep leaving the flag on.
 *
 * Manual-gated: needs a real Chromium application that accepts the attribute.
 *
 *     MACOS_ELECTRON_TARGET=com.moonshot.kimichat npx vitest run packages/computer-macos
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const TARGET = process.env.MACOS_ELECTRON_TARGET ?? ''
const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'dsh-computer-macos-helper')

/** Actionable elements the helper can see in the target's focused window. */
async function actionableCount(bundleId: string, stop: 'stdin' | 'sigterm'): Promise<{ live: number }> {
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', (value: string) => { out += value })
  const latest = (): number => {
    const lines = out.trim().split('\n').flatMap((line) => {
      try { return [JSON.parse(line) as { result?: { elements?: unknown[] } }] } catch { return [] }
    })
    return lines[lines.length - 1]?.result?.elements?.length ?? 0
  }

  // Chromium builds the tree asynchronously; poll until it is populated rather
  // than measuring a tree that has not been built yet.
  let live = 0
  for (let attempt = 0; attempt < 8 && live <= 10; attempt++) {
    child.stdin.write(`${JSON.stringify({ id: attempt + 1, method: 'snapshot', params: { bundleId } })}\n`)
    await new Promise(resolve => setTimeout(resolve, 2_500))
    live = latest()
  }

  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  if (stop === 'stdin') child.stdin.end()
  else child.kill('SIGTERM')
  await closed
  await new Promise(resolve => setTimeout(resolve, 2_000))
  return { live }
}

describe.skipIf(TARGET === '' || process.platform !== 'darwin')('accessibility mode is restored', () => {
  test('a tree that the helper opened collapses again once it exits', async () => {
    const { live } = await actionableCount(TARGET, 'stdin')
    expect(live, 'the target never exposed a tree, so this proves nothing').toBeGreaterThan(10)

    // A second run starts from a restored application: the tree has to be
    // rebuilt, so the first snapshot comes back nearly empty before settling.
    const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { out += value })
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'snapshot', params: { bundleId: TARGET } })}\n`)
    await new Promise(resolve => setTimeout(resolve, 800))
    const first = out.trim().split('\n').flatMap((line) => {
      try { return [JSON.parse(line) as { result?: { elements?: unknown[] } }] } catch { return [] }
    })[0]?.result?.elements?.length ?? 0
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('close', () => resolve(undefined)))

    expect(first, `the target still had ${String(first)} elements immediately after a prior run exited,`
      + ' which means full accessibility mode was left on').toBeLessThan(live / 2)
  }, 120_000)

  test('a helper stopped by signal restores as well as one stopped by stdin', async () => {
    // SIGTERM is how the plugin's fiber actually stops this process, so the
    // signal path is the one that matters most.
    const { live } = await actionableCount(TARGET, 'sigterm')
    expect(live, 'the target never exposed a tree, so this proves nothing').toBeGreaterThan(10)
  }, 120_000)
})
