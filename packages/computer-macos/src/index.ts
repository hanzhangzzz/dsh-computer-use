/**
 * macOS provider for `ctx.computer`: drives native and Electron applications
 * through the Accessibility API, via a Swift helper spoken to over stdio.
 *
 * Structure-first, same as the browser provider: the helper enumerates a
 * window's actionable elements and the model addresses them by index. No
 * private APIs, and no synthesised mouse events — an accessibility action goes
 * straight to the control, which is why it works on a background window
 * without moving the user's cursor or taking their focus.
 * @module dsh-computer-macos
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ComputerClickResult,
  ComputerElement,
  ComputerKeyPressResult,
  ComputerNavigation,
  ComputerProvider,
  ComputerScreenshot,
  ComputerSnapshot,
  ComputerSurface,
  ComputerTypeResult,
} from '../../computer/src/index.ts'
import type { AccessConfig, AppAccess } from './access.ts'
import { checkAccess } from './access.ts'

export { checkAccess, DEFAULT_DENIED } from './access.ts'
export type { AccessConfig, AppAccess, AccessDecision } from './access.ts'

/** Provider id; prefixes every surface id this provider owns. */
export const PROVIDER_ID = 'macos'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'computer-macos'

/** Mounts the provider into the computer seam. */
export const inject = ['computer']

/** Plugin config. */
export interface Config extends AccessConfig {
  /** Helper binary path; defaults to the one shipped beside this module. */
  readonly helperPath?: string
  /** Per-request timeout (ms) for one helper call. Defaults to 20000. */
  readonly requestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  helperPath: z.string().default(''),
  requestTimeoutMs: z.number().default(20_000),
  defaultAppAccess: z.union(['allow', 'deny'] as const).default('allow'),
  apps: z.dict(z.union(['allow', 'deny'] as const)).default({}),
})

/** One line of helper output. */
interface HelperResponse {
  readonly id: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: string; readonly message: string }
}

/** Element as the helper reports it. */
interface HelperElement {
  readonly index: number
  readonly role: string
  readonly name: string
  readonly editable: boolean
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/**
 * The Swift helper as a request/response channel.
 *
 * stdio rather than a local HTTP port (the shape Codex uses): the process is
 * bound to the pipe, so disposal cannot leave a listener behind, and there is
 * no unauthenticated local port for anything else on the machine to reach.
 */
class Helper {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(
    private readonly binaryPath: string,
    private readonly timeoutMs: number,
    private readonly onExit: () => void,
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child
    const child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() === '') return
      let response: HelperResponse
      try {
        response = JSON.parse(line) as HelperResponse
      } catch {
        // A helper that cannot frame its own output is not one to keep trusting.
        return
      }
      const waiter = this.pending.get(response.id)
      if (waiter === undefined) return
      this.pending.delete(response.id)
      clearTimeout(waiter.timer)
      if (response.error !== undefined) waiter.reject(new Error(response.error.message))
      else waiter.resolve(response.result ?? {})
    })
    child.on('exit', () => {
      this.child = undefined
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('the macOS accessibility helper exited'))
      }
      this.pending.clear()
      this.onExit()
    })
    this.child = child
    return child
  }

  /** Send one request and await its response. */
  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.start()
    const id = this.nextId++
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the macOS helper did not answer "${method}" within ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ id, method, ...params === undefined ? {} : { params } })}\n`)
    return promise
  }

  stop(): void {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = undefined
  }
}

/** Drives macOS applications behind the seam. */
class MacosProvider implements ComputerProvider {
  readonly id = PROVIDER_ID
  private readonly helper: Helper
  /** Bundle id of the focused application; every action targets it. */
  private target: string | undefined
  /** Last snapshot's elements, for the identity check before acting. */
  private lastElements: readonly HelperElement[] = []
  private lastFingerprint: { bundleId: string; fingerprint: string; seq: number } | undefined

  constructor(private readonly ctx: Context, private readonly config: Config, helperPath: string) {
    this.helper = new Helper(helperPath, config.requestTimeoutMs ?? 20_000, () => {
      this.lastElements = []
    })
  }

  available(): boolean {
    return process.platform === 'darwin'
  }

  /** Applications the policy permits, as surfaces. */
  async surfaces(): Promise<readonly ComputerSurface[]> {
    const result = await this.helper.call('surfaces')
    const apps = (result.surfaces ?? []) as Array<{ bundleId: string; title: string }>
    return apps
      .filter(app => checkAccess(app.bundleId, this.config).allowed)
      .map(app => ({
        id: `${PROVIDER_ID}:${app.bundleId}`,
        kind: 'app' as const,
        title: app.title,
        locator: app.bundleId,
      }))
  }

  /**
   * Point actions at one application, after checking it may be driven.
   * This is the policy gate: actions route through the focused surface, and
   * focus is the only way to select one.
   */
  async focus(surfaceId: string): Promise<ComputerSurface> {
    const bundleId = surfaceId.startsWith(`${PROVIDER_ID}:`)
      ? surfaceId.slice(PROVIDER_ID.length + 1)
      : surfaceId
    const decision = checkAccess(bundleId, this.config)
    if (!decision.allowed) {
      throw new Error(`computer_focus: ${decision.reason}`)
    }
    const result = await this.helper.call('snapshot', { bundleId })
    this.target = bundleId
    this.lastElements = (result.elements ?? []) as HelperElement[]
    return {
      id: `${PROVIDER_ID}:${bundleId}`,
      kind: 'app',
      title: String(result.title ?? ''),
      locator: bundleId,
    }
  }

  private requireTarget(): string {
    if (this.target === undefined) {
      throw new Error('no application is focused; call computer_surfaces then computer_focus first')
    }
    return this.target
  }

  async snapshot(): Promise<ComputerSnapshot> {
    const bundleId = this.requireTarget()
    const result = await this.helper.call('snapshot', { bundleId })
    const elements = (result.elements ?? []) as HelperElement[]
    this.lastElements = elements
    const title = String(result.title ?? '')
    const projected: ComputerElement[] = elements.map(el => ({
      index: el.index,
      role: el.role,
      name: el.name,
      ...el.rect === undefined ? {} : { rect: el.rect },
    }))
    const text = (result.text ?? []) as string[]

    // Same unchanged-surface collapse as the browser provider, but fingerprinted
    // over the text as well as the controls. Over controls alone it reports "no
    // change" at the exact moment an action produces its result: a calculator's
    // keys are identical before and after, so pressing 7 twice moves the display
    // from 7 to 77 while the element list stays byte-for-byte the same. The
    // model would be told nothing happened.
    const fingerprint = [
      ...projected.map(el => `${el.role}:${el.name}`),
      ...text,
    ].join('\n')
    const last = this.lastFingerprint
    if (last !== undefined && last.bundleId === bundleId && last.fingerprint === fingerprint) {
      return { url: `app:${bundleId}`, title, elements: [], unchangedSince: last.seq }
    }
    this.lastFingerprint = { bundleId, fingerprint, seq: (last?.seq ?? 0) + 1 }
    return {
      url: `app:${bundleId}`,
      title,
      elements: projected,
      ...text.length === 0 ? {} : { text },
    }
  }

  /** The identity the caller believed it was acting on, sent along for checking. */
  private expectation(index: number): { expectRole?: string; expectName?: string } {
    const known = this.lastElements[index]
    return known === undefined ? {} : { expectRole: known.role, expectName: known.name }
  }

  async click(index: number): Promise<ComputerClickResult> {
    const bundleId = this.requireTarget()
    const result = await this.helper.call('press', { bundleId, index, ...this.expectation(index) })
    warnIfDisturbed(this.ctx, result)
    const after = await this.snapshot()
    return { clicked: String(result.acted ?? `element ${index}`), url: `app:${bundleId}`, after }
  }

  async type(index: number, text: string): Promise<ComputerTypeResult> {
    const bundleId = this.requireTarget()
    const result = await this.helper.call('setValue', { bundleId, index, text, ...this.expectation(index) })
    warnIfDisturbed(this.ctx, result)
    const after = await this.snapshot()
    return { filled: String(result.filled ?? `element ${index}`), text, after }
  }

  async navigate(): Promise<ComputerNavigation> {
    throw new Error('computer_navigate opens URLs in a browser; to drive an application use computer_surfaces then computer_focus')
  }

  /**
   * Press whatever sits at a screen coordinate — without synthesising a mouse
   * event.
   *
   * The point is hit-tested through the accessibility API and the element it
   * resolves to is pressed the same way any indexed element is. That keeps the
   * co-driving invariant, and it makes a coordinate click checkable before it
   * happens, which a synthesised click can never be: the result says what the
   * point resolved to, and a mismatch can be refused instead of discovered
   * afterwards.
   *
   * Its limit is honest: a point over something the tree does not model — the
   * inside of a canvas — resolves to the container and is refused, because
   * pressing the container is not what was asked for.
   */
  async clickAt(x: number, y: number): Promise<ComputerClickResult> {
    const bundleId = this.requireTarget()
    const result = await this.helper.call('pressAt', { bundleId, x, y })
    warnIfDisturbed(this.ctx, result)
    const after = await this.snapshot()
    return {
      clicked: `${String(result.acted ?? `(${x}, ${y})`)} at (${x}, ${y})`,
      url: `app:${bundleId}`,
      after,
    }
  }

  async pressKey(): Promise<ComputerKeyPressResult> {
    throw new Error('computer_press_key is not implemented for desktop applications yet')
  }

  async screenshot(): Promise<ComputerScreenshot> {
    throw new Error('desktop screenshots are not implemented yet; use computer_snapshot to read the window')
  }

  async close(): Promise<void> {
    this.helper.stop()
  }
}

/**
 * Surface the invariant breach rather than letting it pass. The helper checks
 * after every action whether focus or the cursor moved; a true here means the
 * co-driving guarantee failed and it is a defect, not a detail.
 */
function warnIfDisturbed(ctx: Context, result: Record<string, unknown>): void {
  if (result.focusStolen === true || result.cursorMoved === true) {
    ctx.logger?.warn?.(
      'computer-macos: an action disturbed the user (focusStolen=%s cursorMoved=%s) — this breaks the co-driving invariant',
      result.focusStolen,
      result.cursorMoved,
    )
  }
}

/** Default helper location: shipped beside the built module. */
function bundledHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'dsh-computer-macos-helper')
}

/** Register the provider into `ctx.computer`. */
export function apply(ctx: Context, config: Config): void {
  if (process.platform !== 'darwin') return
  const helperPath = config.helperPath !== undefined && config.helperPath !== ''
    ? config.helperPath
    : bundledHelperPath()
  const provider = new MacosProvider(ctx, config, helperPath)
  ctx.computer.registerProvider(provider)
}
