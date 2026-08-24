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
  ComputerNavigation,
  ComputerProvider,
  ComputerScreenshot,
  ComputerSnapshot,
} from 'dsh-computer'
import type {} from 'dsh-computer'

/** Selector for elements the snapshot exposes as interactive. */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]'

/** Plugin config: which Chrome to drive and at what viewport. */
export interface Config {
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

/** One live Chrome page behind the seam. */
class PlaywrightProvider implements ComputerProvider {
  readonly id = PROVIDER_ID
  private page: Page | undefined

  constructor(private readonly ctx: Context, private readonly config: Required<Config>) {}

  available(): boolean {
    // playwright-core launches lazily; the provider is usable whenever the
    // plugin is mounted. Launch failures surface at first use, loudly.
    return true
  }

  /** The single page, launched on first use. */
  private async getPage(signal?: AbortSignal): Promise<Page> {
    if (this.page !== undefined) return this.page
    const browser: Browser = await chromium.launch({
      channel: this.config.channel,
      headless: this.config.headless,
    })
    throwIfAborted(signal)
    const context = await browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
    })
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    page.setDefaultTimeout(this.config.actionTimeoutMs)
    // Browser and context die with the page's browser; closing the browser
    // closes both. Registered once for the first page only.
    this.ctx.effect(function* () {
      yield () => void browser.close()
    }, 'computer-playwright.launch()')
    this.page = page
    return page
  }

  async navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation> {
    const page = await this.getPage(signal)
    const response = await page.goto(url, { timeout: this.config.navigationTimeoutMs })
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
    const page = await this.getPage(signal)
    const handle = await page.evaluateHandle(selector => {
      const nodes = Array.from(document.querySelectorAll(selector))
      return nodes.map((node, index) => {
        const el = node as HTMLElement
        const role =
          el.getAttribute('role')
          ?? (el instanceof HTMLAnchorElement ? 'link'
            : el instanceof HTMLButtonElement ? 'button'
            : el instanceof HTMLInputElement ? (el.type === 'checkbox' || el.type === 'radio' ? el.type : 'textbox')
            : el instanceof HTMLSelectElement ? 'select'
            : el instanceof HTMLTextAreaElement ? 'textbox'
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
        return { index, role, name: name.slice(0, 200) }
      })
    }, INTERACTIVE_SELECTOR)
    throwIfAborted(signal)
    const elements = (await handle.jsonValue()) as ComputerElement[]
    await handle.dispose()
    return { url: page.url(), title: await page.title(), elements }
  }

  async click(index: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    const page = await this.getPage(signal)
    const locator = page.locator(INTERACTIVE_SELECTOR).nth(index)
    const described = await describeLocator(locator)
    await locator.click()
    return { clicked: described, url: page.url() }
  }

  async screenshot(signal?: AbortSignal): Promise<ComputerScreenshot> {
    const page = await this.getPage(signal)
    const data = await page.screenshot({ type: 'png' })
    return {
      data,
      mediaType: 'image/png',
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
    }
  }

  async close(): Promise<void> {
    // Browser teardown goes through the registered effect; the page handle
    // itself needs no separate close.
    this.page = undefined
  }
}

/** One-line role+name description of a locator for click verification. */
async function describeLocator(locator: import('playwright-core').Locator): Promise<string> {
  const role = await locator.evaluate(node => {
    const el = node as HTMLElement
    return el.getAttribute('role')
      ?? (el instanceof HTMLAnchorElement ? 'link'
        : el instanceof HTMLButtonElement ? 'button'
        : el instanceof HTMLSelectElement ? 'select'
        : 'other')
  })
  const name = (await locator.innerText().catch(() => '')) || await locator.getAttribute('aria-label').catch(() => null) || ''
  return `${role} "${name.slice(0, 120)}"`
}

/** Fail fast on cancellation between async steps. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('the computer call was canceled')
}

/** Register the provider into `ctx.computer`. */
export function apply(ctx: Context, config: Config): void {
  const resolved: Required<Config> = {
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
