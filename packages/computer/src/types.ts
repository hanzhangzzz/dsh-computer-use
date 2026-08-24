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
   * Sequence number of the first snapshot this page state is identical to;
   * present (with empty `elements`) when the provider recognizes an unchanged
   * page. Indices from that snapshot remain valid.
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

/**
 * A computer use provider: drives one interactive surface. Implementations
 * must forward cancellation into their underlying driver wherever feasible.
 */
export interface ComputerProvider {
  /** Registry key; unique within the seam. */
  readonly id: string
  /** False while the backing surface cannot run (no browser, no sandbox). */
  available(): boolean
  /** Load a URL and wait for settle. */
  navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation>
  /** Enumerate interactive elements with stable indices. */
  snapshot(signal?: AbortSignal): Promise<ComputerSnapshot>
  /** Click the element at {@link ComputerElement.index} from the last snapshot. */
  click(index: number, signal?: AbortSignal): Promise<ComputerClickResult>
  /** Type text into the element at {@link ComputerElement.index} from the last snapshot. */
  type(index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult>
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
