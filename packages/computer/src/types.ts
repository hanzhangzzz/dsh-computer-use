/**
 * Types for the computer use capability seam. One provider drives one
 * interactive surface (a browser tab today; a desktop later). The seam is
 * structure-first: {@link ComputerProvider.snapshot} returns an element index
 * the model addresses by number, and screenshots are an explicit verification
 * channel, never the primary targeting path (measured grounding evidence in
 * the repo README, Phase 0).
 */

/** An interactive element as surfaced by {@link ComputerProvider.snapshot}. */
export interface ComputerElement {
  /** Index the model passes to click/type; stable within one snapshot. */
  readonly index: number
  /** Landmark role: link, button, textbox, checkbox, select, option, other. */
  readonly role: string
  /** Accessible name: text content, aria-label, or value. May be empty. */
  readonly name: string
}

/** Structure-first view of the current surface. */
export interface ComputerSnapshot {
  /** Current URL after any redirects. */
  readonly url: string
  /** Document title. */
  readonly title: string
  /** Interactive elements in DOM order; the model addresses these by index. */
  readonly elements: readonly ComputerElement[]
  /**
   * What the surface is displaying, in reading order — labels, values,
   * readouts. Omitted by providers whose element names already carry the
   * page's text, which is the browser case.
   *
   * A desktop window is the case that needs it. Enumerating only actionable
   * elements leaves a model able to press a calculator's keys and unable to
   * read its answer, which is the difference between acting and completing a
   * task.
   */
  readonly text?: readonly string[]
  /**
   * Sequence number of the first snapshot this state is identical to; present
   * (with empty `elements`) when the provider recognizes an unchanged surface.
   * Indices from that snapshot remain valid.
   *
   * "Unchanged" must account for {@link text}. A calculator's buttons are the
   * same before and after it computes an answer, so a fingerprint taken over
   * elements alone reports no change at the exact moment the result appears.
   */
  readonly unchangedSince?: number
}

/** Outcome of one navigation. */
export interface ComputerNavigation {
  /** Final URL after redirects. */
  readonly url: string
  /** Document title after load. */
  readonly title: string
}

/** Outcome of one click, reported for model-side verification. */
export interface ComputerClickResult {
  /** Description of the clicked element (role + name). */
  readonly clicked: string
  /** URL after the click settled (navigation may or may not have happened). */
  readonly url: string
  /** Snapshot taken after the click settled; the click loop's new baseline. */
  readonly after: ComputerSnapshot
}

/** Outcome of one text input, reported for model-side verification. */
export interface ComputerTypeResult {
  /** Description of the filled element (role + name). */
  readonly filled: string
  /** The text that was entered. */
  readonly text: string
  /** Snapshot taken after the input settled; the input loop's new baseline. */
  readonly after: ComputerSnapshot
}

/** A PNG screenshot for visual verification. */
export interface ComputerScreenshot {
  /** Encoded PNG bytes. */
  readonly data: Uint8Array
  /** Always `image/png` for this seam version. */
  readonly mediaType: 'image/png'
  /** Pixel width. */
  readonly width: number
  /** Pixel height. */
  readonly height: number
}

/** Outcome of one key press, reported for model-side verification. */
export interface ComputerKeyPressResult {
  /** The key that was pressed, in Playwright key syntax (e.g. `Enter`, `Escape`). */
  readonly key: string
  /** Snapshot taken after the press settled; the interaction's new baseline. */
  readonly after: ComputerSnapshot
}

/**
 * One thing a provider can drive: a browser page, or a desktop application.
 *
 * Surfaces exist so a browser provider and a desktop provider can be mounted
 * at once. Before this the seam refused that outright — two usable providers
 * raised `COMPUTER_PROVIDER_AMBIGUOUS` — because "which one did you mean" had
 * no answer. A surface id is that answer, and it keeps the original property
 * the ambiguity error was protecting: selection never depends on registration
 * order, because the caller names the target.
 */
export interface ComputerSurface {
  /** `<providerId>:<local>`, e.g. `playwright:page`, `macos:com.apple.finder`. */
  readonly id: string
  /** `browser` for a web page, `app` for a desktop application. */
  readonly kind: 'browser' | 'app'
  /** Window or document title, for the model to recognise it by. */
  readonly title: string
  /** URL for a browser surface, bundle id for an application. */
  readonly locator: string
}

/**
 * A computer use provider: drives one or more interactive surfaces.
 * Implementations must forward cancellation into their underlying driver
 * wherever feasible.
 *
 * Action methods stay surface-free and act on whichever surface {@link focus}
 * last selected. Providers that drive exactly one surface (the browser one)
 * implement `focus` as a no-op.
 */
export interface ComputerProvider {
  /** Registry key; unique within the seam. Prefixes this provider's surface ids. */
  readonly id: string
  /** False while the backing surface cannot run (no browser, no sandbox). */
  available(): boolean
  /** Every surface this provider can drive right now. */
  surfaces(signal?: AbortSignal): Promise<readonly ComputerSurface[]>
  /**
   * Point subsequent actions at one of this provider's surfaces.
   * @param surfaceId - an id from {@link surfaces}.
   */
  focus(surfaceId: string, signal?: AbortSignal): Promise<ComputerSurface>
  /** Load a URL and wait for settle. */
  navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation>
  /** Enumerate interactive elements with stable indices. */
  snapshot(signal?: AbortSignal): Promise<ComputerSnapshot>
  /** Click the element at {@link ComputerElement.index} from the last snapshot. */
  click(index: number, signal?: AbortSignal): Promise<ComputerClickResult>
  /** Click raw viewport coordinates (CSS px, origin top-left) — the fallback for visible-but-unenumerated targets. */
  clickAt(x: number, y: number, signal?: AbortSignal): Promise<ComputerClickResult>
  /** Type text into the element at {@link ComputerElement.index} from the last snapshot. */
  type(index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult>
  /** Press one keyboard key (e.g. `Enter`, `Escape`) on the focused element. */
  pressKey(key: string, signal?: AbortSignal): Promise<ComputerKeyPressResult>
  /** Capture the current viewport as PNG. */
  screenshot(signal?: AbortSignal): Promise<ComputerScreenshot>
  /** Release the backing surface; called once on dispose. */
  close(): Promise<void>
}

/** Error type for the seam; codes are stable identifiers for callers. */
export class ComputerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}
