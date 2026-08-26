/**
 * Playwright provider for `ctx.computer`: one lazily-launched headless Chrome
 * over playwright-core. Structure-first by construction — snapshot enumerates
 * interactive elements with stable indices and click addresses them by index
 * through Playwright's auto-waiting locators; screenshots are the explicit
 * visual-verification channel.
 * @module dsh-computer-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
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

/** Selector for elements the snapshot exposes as interactive. */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'

/** Plugin config: which Chrome to drive and at what viewport. */
export interface Config {
  /** CDP endpoint to attach to (e.g. http://127.0.0.1:9222). When set, the provider attaches to an already-running Chromium-based app (any Electron app with remote debugging on) instead of launching Chrome. */
  cdpEndpoint?: string
  /** Chrome channel passed to playwright-core; defaults to `chrome`. */
  channel?: string
  /** Headless launch; defaults to true. */
  headless?: boolean
  /** Viewport width in CSS pixels; defaults to 1280 (Phase 0 calibration). */
  viewportWidth?: number
  /** Viewport height in CSS pixels; defaults to 800 (Phase 0 calibration). */
  viewportHeight?: number
  /** Navigation timeout ms; defaults to 30000. */
  navigationTimeoutMs?: number
  /** Action timeout ms; defaults to 5000 (Playwright default). */
  actionTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  cdpEndpoint: z.string().default(''),
  channel: z.string().default('chrome'),
  headless: z.boolean().default(true),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(800),
  navigationTimeoutMs: z.number().default(30_000),
  actionTimeoutMs: z.number().default(5_000),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'computer-playwright'

/** Mounts the provider into the computer seam. */
export const inject = ['computer']

/** Provider id this package registers under. */
export const PROVIDER_ID = 'playwright'

/** The single surface this provider drives; the seam routes on its prefix. */
export const SURFACE_ID = `${PROVIDER_ID}:page`

/** One live Chrome page behind the seam. */
class PlaywrightProvider implements ComputerProvider {
  readonly id = PROVIDER_ID
  private page: Page | undefined
  /** Fingerprint of the last full snapshot, for unchanged-page detection. */
  private lastSnapshot: { url: string; fingerprint: string; seq: number } | undefined
  /** Set when an attached app disconnects; later calls fail with guidance. */
  private detached = false

  constructor(private readonly ctx: Context, private readonly config: Required<Config>) {}

  available(): boolean {
    // playwright-core launches or attaches lazily; the provider is usable
    // whenever the plugin is mounted. Failures surface at first use, loudly.
    return true
  }

  /**
   * This provider drives exactly one page, so it reports exactly one surface.
   * Enumerating it must not launch a browser — listing surfaces is how a caller
   * decides whether to use this provider at all, and paying a Chrome start-up
   * to answer that would make the listing useless on a machine that only wants
   * the desktop provider.
   */
  async surfaces(): Promise<readonly ComputerSurface[]> {
    const page = this.page
    return [{
      id: SURFACE_ID,
      kind: 'browser',
      title: page === undefined ? 'browser (not started)' : await page.title().catch(() => ''),
      locator: page === undefined ? 'about:blank' : page.url(),
    }]
  }

  /** Single-surface provider: focusing its own surface is a no-op. */
  async focus(surfaceId: string): Promise<ComputerSurface> {
    if (surfaceId !== SURFACE_ID) {
      throw new Error(`computer_focus: this provider only drives "${SURFACE_ID}", not "${surfaceId}"`)
    }
    const [surface] = await this.surfaces()
    return surface as ComputerSurface
  }

  /** The single page, launched or attached on first use. */
  private async getPage(signal?: AbortSignal): Promise<Page> {
    if (this.page !== undefined) return this.page
    const attach = this.config.cdpEndpoint !== ''
    const browser: Browser = attach
      // Attach to an already-running Chromium-based app (Electron with remote
      // debugging). Closing an attached browser is not ours to do; disposal
      // only detaches.
      ? await chromium.connectOverCDP(this.config.cdpEndpoint)
      : await chromium.launch({
        channel: this.config.channel,
        headless: this.config.headless,
      })
    throwIfAborted(signal)
    const context = attach
      // An attached app already owns its contexts; adopt the first with pages.
      ? (browser.contexts().find(c => c.pages().length > 0) ?? await browser.newContext())
      : await browser.newContext({
        viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      })
    const page = attach ? (context.pages()[0] ?? await context.newPage()) : await context.newPage()
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    page.setDefaultTimeout(this.config.actionTimeoutMs)
    if (!attach) {
      // The launched browser dies with the effect; an attached one stays.
      this.ctx.effect(function* () {
        yield () => void browser.close()
      }, 'computer-playwright.launch()')
    } else {
      // A detached attach is a terminal state by design: the host app owns
      // its lifecycle, so the model must report and wait, never restart it
      // (unattended "rescue" attempts are how the incident of 2026-08-25
      // started). Fail loud with that guidance on every later call.
      browser.on('disconnected', () => {
        this.detached = true
        this.page = undefined
      })
    }
    this.page = page
    return page
  }

  /** Guard every entry point against a detached attachment. */
  private requireAttached(): void {
    if (this.detached) {
      throw new Error('the attached application has disconnected (it was closed or crashed); report this to the user and wait — do not restart the application yourself')
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation> {
    this.requireAttached()
    const page = await this.getPage(signal)
    // domcontentloaded, not load: hostile external sites that stall after the
    // document arrives would otherwise burn the full navigation timeout per
    // attempt (measured: 4×30s on a blocked x.com link). The error page's DOM
    // settles in seconds; interactive content loads after, as everywhere else.
    const response = await page.goto(url, { timeout: this.config.navigationTimeoutMs, waitUntil: 'domcontentloaded' })
    if (response === null) {
      // A null response still leaves a loaded document (e.g. downloads,
      // same-document jumps); report the settled state.
      return { url: page.url(), title: await page.title() }
    }
    if (!response.ok()) {
      throw new Error(`navigation to ${url} returned HTTP ${response.status()}`)
    }
    return { url: page.url(), title: await page.title() }
  }

  async snapshot(signal?: AbortSignal): Promise<ComputerSnapshot> {
    this.requireAttached()
    const page = await this.getPage(signal)
    const handles = await interactiveHandles(page)
    const elements: ComputerElement[] = []
    for (const handle of handles) {
      const described = await describeElement(handle)
      elements.push({ ...described, index: elements.length })
    }
    throwIfAborted(signal)
    const url = page.url()
    const title = await page.title()
    const fingerprint = `${url}\n${elements.map(el => `${el.role}:${el.name}`).join('\n')}`
    const last = this.lastSnapshot
    if (last !== undefined && last.url === url && last.fingerprint === fingerprint) {
      return { url, title, elements: [], unchangedSince: last.seq }
    }
    this.lastSnapshot = { url, fingerprint, seq: (last?.seq ?? 0) + 1 }
    return { url, title, elements }
  }

  async click(index: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    this.requireAttached()
    const page = await this.getPage(signal)
    const handles = await interactiveHandles(page)
    const handle = handles[index]
    if (handle === undefined) throw new Error(`computer_click: no element at index ${index}; take a fresh snapshot`)
    const target = await describeElement(handle)
    const described = `${target.role} "${target.name}"`
    await handle.click()
    // The post-click snapshot is the next iteration's baseline. A click that
    // triggers navigation must wait for the new document before enumeration;
    // a same-page click fails that wait immediately, which is fine.
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(300)
    const after = await this.snapshot(signal)
    return { clicked: described, url: page.url(), after }
  }

  async clickAt(x: number, y: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    this.requireAttached()
    const page = await this.getPage(signal)
    // `page.mouse` dispatches through CDP into the renderer as a real mouse
    // event sequence (move/down/up), so synthetic-event frameworks and hover
    // affordances behave as they do for a user, and the system cursor never
    // moves. Its coordinate space is CSS pixels — the same space screenshot()
    // now reports, which is what makes a coordinate read off the image valid.
    // Name what the coordinates actually hit so the caller can tell a miss
    // from a no-op click; hit-testing does not move or activate anything.
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      if (!(el instanceof HTMLElement)) return null
      return `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 60)}"`
    }, { x, y })
    if (hit === null) {
      throw new Error(`computer_click: no element at viewport coordinates (${x}, ${y}); the viewport is ${await viewportSize(page)} CSS pixels — take a fresh screenshot and read the coordinates off it`)
    }
    await page.mouse.click(x, y)
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(300)
    const after = await this.snapshot(signal)
    return { clicked: `${hit} at viewport coordinates (${x}, ${y})`, url: page.url(), after }
  }

  async type(index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult> {
    this.requireAttached()
    const page = await this.getPage(signal)
    const handles = await interactiveHandles(page)
    const handle = handles[index]
    if (handle === undefined) throw new Error(`computer_type: no element at index ${index}; take a fresh snapshot`)
    const target = await describeElement(handle)
    const described = `${target.role} "${target.name}"`
    await handle.fill(text)
    await page.waitForTimeout(300)
    const after = await this.snapshot(signal)
    return { filled: described, text, after }
  }

  async pressKey(key: string, signal?: AbortSignal): Promise<ComputerKeyPressResult> {
    this.requireAttached()
    const page = await this.getPage(signal)
    await page.keyboard.press(key)
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(300)
    const after = await this.snapshot(signal)
    return { key, after }
  }

  async screenshot(signal?: AbortSignal): Promise<ComputerScreenshot> {
    this.requireAttached()
    const page = await this.getPage(signal)
    // `scale: 'css'` makes one image pixel one CSS pixel, so a coordinate read
    // off this image is directly usable by clickAt. Without it a Retina or
    // attached host renders at devicePixelRatio and every coordinate the model
    // derives is off by that factor (measured 2× on the WeChat devtools host).
    const data = await page.screenshot({ type: 'png', scale: 'css' })
    // Report the image's own dimensions, never the configured viewport: attach
    // mode adopts the host application's context and never applies that config.
    const [width, height] = pngSize(data)
    return { data, mediaType: 'image/png', width, height }
  }

  async close(): Promise<void> {
    // Browser teardown goes through the registered effect; the page handle
    // itself needs no separate close.
    this.page = undefined
  }
}

/** Fail fast on cancellation between async steps. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('the computer call was canceled')
}

/**
 * Pixel dimensions of a PNG, read from the IHDR chunk that a valid PNG always
 * carries at a fixed offset.
 * @param data Complete PNG bytes as produced by `page.screenshot`.
 * @returns `[width, height]` in image pixels.
 */
function pngSize(data: Buffer): [number, number] {
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

/** `WxH` CSS-pixel viewport of a page, for coordinate error messages. */
async function viewportSize(page: Page): Promise<string> {
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  return `${width}x${height}`
}

/**
 * Filtered interactive-element handles on one page, in DOM order — the single
 * authority for snapshot indices: snapshot describes them, click/type address
 * them by position in this array. Hidden regions are skipped, and so are
 * interlanguage switcher links (an `a` whose `lang` differs from the document
 * language) — measured on Wikipedia these are half the element list and almost
 * never the task target. A navigation racing the enumeration destroys the
 * execution context; that failure waits for the new document and retries once
 * instead of surfacing to the model.
 */
async function interactiveHandles(page: Page): Promise<Array<import('playwright-core').ElementHandle<HTMLElement>>> {
  const collect = () => page.evaluateHandle(selector => {
    const nodes = Array.from(document.querySelectorAll(selector))
    const docLang = document.documentElement.lang || ''
    const out: HTMLElement[] = []
    for (const node of nodes) {
      const el = node as HTMLElement
      if (el.closest('[aria-hidden="true"]') !== null) continue
      const elLang = el.getAttribute('lang')
      if (el instanceof HTMLAnchorElement && elLang !== null && elLang !== '' && elLang !== docLang) continue
      out.push(el)
    }
    return out
  }, INTERACTIVE_SELECTOR)
  const resolve = async () => {
    const arrayHandle = await collect()
    const properties = await arrayHandle.getProperties()
    await arrayHandle.dispose()
    return [...properties.values()] as Array<import('playwright-core').ElementHandle<HTMLElement>>
  }
  try {
    return await resolve()
  } catch (error: unknown) {
    if (!(error instanceof Error) || !String(error.message).includes('Execution context was destroyed')) throw error
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {})
    return await resolve()
  }
}

/** Role+name projection of one enumerated element, matching snapshot indices. */
async function describeElement(handle: import('playwright-core').ElementHandle<HTMLElement>): Promise<ComputerElement> {
  return handle.evaluate(el => {
    const role =
      el.getAttribute('role')
      ?? (el instanceof HTMLAnchorElement ? 'link'
        : el instanceof HTMLButtonElement ? 'button'
        : el instanceof HTMLInputElement ? (el.type === 'checkbox' || el.type === 'radio' ? el.type : 'textbox')
        : el instanceof HTMLTextAreaElement ? 'textbox'
        : el instanceof HTMLSelectElement ? 'select'
        : el.isContentEditable ? 'textbox'
        : 'other')
    const name =
      el.getAttribute('aria-label')
      ?? (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? (el.value || el.placeholder)
        : el instanceof HTMLSelectElement
          ? el.value
          : (el.textContent ?? '').trim())
      ?? ''
    return { index: 0, role, name: String(name).slice(0, 200) }
  })
}

/** Register the provider into `ctx.computer`. */
export function apply(ctx: Context, config: Config): void {
  const resolved: Required<Config> = {
    cdpEndpoint: config.cdpEndpoint ?? '',
    channel: config.channel ?? 'chrome',
    headless: config.headless ?? true,
    viewportWidth: config.viewportWidth ?? 1280,
    viewportHeight: config.viewportHeight ?? 800,
    navigationTimeoutMs: config.navigationTimeoutMs ?? 30_000,
    actionTimeoutMs: config.actionTimeoutMs ?? 5_000,
  }
  const provider = new PlaywrightProvider(ctx, resolved)
  ctx.computer.registerProvider(provider)
}
