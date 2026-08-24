/**
 * Model-facing `computer_snapshot`, `computer_click`, and `computer_screenshot`
 * over `ctx.computer`. This package owns schemas, prompt guidance, and
 * presentation, never concrete providers. Structure-first: the workflow the
 * tools teach is snapshot → click by index → screenshot to verify; the
 * screenshot description forbids code-based image analysis because the image
 * is delivered to the model directly (measured lesson E6, Phase 1).
 * @module dsh-tool-computer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from 'dsh-computer'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-computer'

/** Tools, the computer seam, prompt sections, and the durable image store. */
export const inject = ['tools', 'computer', 'systemPrompt', 'attachments']

/** Default cooperative tool-call timeout budget (ms). */
export const DEFAULT_COMPUTER_TOOL_TIMEOUT_MS = 60_000

/** Plugin config: per-tool budgets and the screenshot output toggle. */
export interface Config {
  /** Cooperative timeout budget (ms) per computer tool call. Defaults to 60000. */
  timeoutMs?: number
  /** Register `computer_screenshot`. Defaults to true. */
  screenshot?: boolean
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_COMPUTER_TOOL_TIMEOUT_MS),
  screenshot: z.boolean().default(true),
})

/** JSON Schema for one canonical snapshot value, shared by click/type outputs. */
const SNAPSHOT_VALUE_PROPERTIES = {
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
  elements: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'integer', required: true },
        role: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
    },
  },
  unchangedSince: { type: 'integer' },
} as const

export interface ComputerScreenshotValue {
  readonly attachmentId: string
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  readonly bytes: number
}

/** The shared prompt section teaching the structure-first workflow. */
const WORKFLOW_PROMPT = [
  'Use the computer tools to drive a browser: take computer_snapshot first,',
  'address interactive elements by their snapshot index with computer_click,',
  'and call computer_screenshot only to visually verify or describe what the',
  'page looks like. The screenshot is delivered to you as an image — describe',
  'it directly; never write code to analyze it and never fall back to OCR.',
].join(' ')

/**
 * Register the computer tool suite. All disposers are fiber-scoped through
 * the effect-based registries, so plugin dispose unregisters everything.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? DEFAULT_COMPUTER_TOOL_TIMEOUT_MS
  ctx.systemPrompt.section({
    name: 'tools:computer',
    order: 121,
    text: WORKFLOW_PROMPT,
  })

  ctx.tools.register(defineTool({
    name: 'computer_navigate',
    description: 'Open a URL in the browser page and wait for it to load. Returns the settled URL and page title.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `loaded ${(value as { url: string }).url} — ${(value as { title: string }).title}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { url } = parseNavigateArgs(args)
      const nav = await ctx.computer.navigate(url, exec.signal)
      return { url: nav.url, title: nav.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_snapshot',
    description: 'List the interactive elements of the current browser page with stable indices, plus its URL and title. Always call this before clicking.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          unchangedSince: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const snap = await ctx.computer.snapshot(exec.signal)
      return {
        url: snap.url,
        title: snap.title,
        elements: [...snap.elements],
        ...snap.unchangedSince !== undefined ? { unchangedSince: snap.unchangedSince } : {},
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description: 'Click the interactive element at the given index from the latest computer_snapshot. Returns what was clicked, where the page went, and the post-click snapshot (element indices for the next click; an "unchanged" marker means the prior indices remain valid).',
    parameters: {
      index: { type: 'number', required: true, description: 'Element index from computer_snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'string', required: true },
          url: { type: 'string', required: true },
          after: { type: 'object', required: true, additionalProperties: false, properties: SNAPSHOT_VALUE_PROPERTIES },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatClick(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { index } = parseClickArgs(args)
      const result = await ctx.computer.click(index, exec.signal)
      const after = result.after
      return {
        clicked: result.clicked,
        url: result.url,
        after: {
          url: after.url,
          title: after.title,
          elements: [...after.elements],
          ...after.unchangedSince !== undefined ? { unchangedSince: after.unchangedSince } : {},
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_type',
    description: 'Type text into the textbox element at the given index from the latest snapshot (replaces existing content). Returns what was filled and the post-input snapshot with updated element names.',
    parameters: {
      index: { type: 'number', required: true, description: 'Element index from the latest snapshot.' },
      text: { type: 'string', required: true, description: 'Text to enter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filled: { type: 'string', required: true },
          text: { type: 'string', required: true },
          after: { type: 'object', required: true, additionalProperties: false, properties: SNAPSHOT_VALUE_PROPERTIES },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatType(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { index, text } = parseTypeArgs(args)
      const result = await ctx.computer.type(index, text, exec.signal)
      const after = result.after
      return {
        filled: result.filled,
        text: result.text,
        after: {
          url: after.url,
          title: after.title,
          elements: [...after.elements],
          ...after.unchangedSince !== undefined ? { unchangedSince: after.unchangedSince } : {},
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_press_key',
    description: 'Press one keyboard key on the focused element (e.g. `Enter` to submit a filled form, `Escape` to dismiss). Returns the post-press snapshot.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key in Playwright syntax: Enter, Escape, Tab, ArrowDown, or a single character.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          after: { type: 'object', required: true, additionalProperties: false, properties: SNAPSHOT_VALUE_PROPERTIES },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatKeyPress(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { key } = parseKeyPressArgs(args)
      const result = await ctx.computer.pressKey(key, exec.signal)
      const after = result.after
      return {
        key: result.key,
        after: {
          url: after.url,
          title: after.title,
          elements: [...after.elements],
          ...after.unchangedSince !== undefined ? { unchangedSince: after.unchangedSince } : {},
        },
      }
    },
  }))

  if (config.screenshot ?? true) {
    ctx.tools.register(defineTool({
      name: 'computer_screenshot',
      description: 'Capture the current browser viewport as an image delivered to you directly. Use it to visually verify a page state or describe layout, colors, and content. Do not write code to analyze the image and do not use OCR — you can see it.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string', required: true },
            mediaType: { type: 'string', required: true, const: 'image/png' },
            width: { type: 'integer', required: true },
            height: { type: 'integer', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => renderScreenshot(value),
      },
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(_args, exec) {
        const shot = await ctx.computer.screenshot(exec.signal)
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new Error('no attachment store is mounted')
        const [ref] = await attachments.saveImages([{ data: shot.data, mediaType: shot.mediaType }])
        return screenshotValue(ref)
      },
    }))
  }
}

/** Narrow validated navigate args. */
function parseNavigateArgs(args: unknown): { url: string } {
  const value = args as { url?: unknown }
  if (typeof value.url !== 'string' || !/^https?:\/\//.test(value.url)) {
    throw new Error('computer_navigate: url must be an http(s) URL string')
  }
  return { url: value.url }
}

/** Narrow validated click args. */
function parseClickArgs(args: unknown): { index: number } {
  const value = args as { index?: unknown }
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) {
    throw new Error('computer_click: index must be a non-negative integer from computer_snapshot')
  }
  return { index: value.index }
}

/** Narrow validated type args. */
function parseTypeArgs(args: unknown): { index: number; text: string } {
  const value = args as { index?: unknown; text?: unknown }
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) {
    throw new Error('computer_type: index must be a non-negative integer from the latest snapshot')
  }
  if (typeof value.text !== 'string') {
    throw new Error('computer_type: text must be a string')
  }
  return { index: value.index, text: value.text }
}

/** Narrow validated key-press args. */
function parseKeyPressArgs(args: unknown): { key: string } {
  const value = args as { key?: unknown }
  if (typeof value.key !== 'string' || value.key.length === 0 || value.key.length > 32) {
    throw new Error('computer_press_key: key must be a short non-empty string (e.g. "Enter")')
  }
  return { key: value.key }
}

/** Lossy display of a key-press result. */
function formatKeyPress(value: JsonValue): string {
  const press = value as { key: string; after: { unchangedSince?: number } }
  const after = press.after.unchangedSince !== undefined
    ? `unchanged since snapshot #${press.after.unchangedSince} (prior indices remain valid)`
    : formatSnapshot((value as { after: JsonValue }).after)
  return [`pressed ${press.key}`, '', after].join('\n')
}

/** Lossy display of a type result: what was filled plus the post-input view. */
function formatType(value: JsonValue): string {
  const typed = value as { filled: string; text: string; after: { unchangedSince?: number } }
  const after = typed.after.unchangedSince !== undefined
    ? `unchanged since snapshot #${typed.after.unchangedSince} (prior indices remain valid)`
    : formatSnapshot((value as { after: JsonValue }).after)
  return [`filled ${typed.filled} with "${typed.text}"`, '', after].join('\n')
}

/** Lossy display of a snapshot value for model-facing text. */
function formatSnapshot(value: JsonValue): string {
  const snap = value as { url: string; title: string; elements: Array<{ index: number; role: string; name: string }>; unchangedSince?: number }
  if (snap.unchangedSince !== undefined) {
    return [
      `# ${snap.title}`,
      snap.url,
      '',
      `unchanged since snapshot #${snap.unchangedSince}: the page's interactive elements are identical; indices from that snapshot remain valid.`,
    ].join('\n')
  }
  const lines = [`# ${snap.title}`, snap.url, '']
  for (const el of snap.elements) {
    const label = el.name === '' ? '' : ` "${el.name}"`
    lines.push(`${el.index}: ${el.role}${label}`)
  }
  return lines.join('\n')
}

/** Coerce a validated canonical value for two-field reads. */
function stringify(value: JsonValue): { clicked: string; url: string } {
  return value as { clicked: string; url: string }
}

/** Lossy display of a click result: what was clicked plus the post-click view. */
function formatClick(value: JsonValue): string {
  const click = value as { clicked: string; url: string; after: { url: string; title: string; elements: Array<{ index: number; role: string; name: string }>; unchangedSince?: number } }
  const after = click.after.unchangedSince !== undefined
    ? `unchanged since snapshot #${click.after.unchangedSince} (prior indices remain valid)`
    : formatSnapshot(click.after)
  return [`clicked ${click.clicked}; now at ${click.url}`, '', after].join('\n')
}

/** Project the screenshot value: the image block plus its text metadata. */
function renderScreenshot(value: JsonValue): ContentBlock[] {
  const shot = value as unknown as ComputerScreenshotValue
  const image: ContentBlock = {
    type: 'image',
    attachment: {
      attachmentId: shot.attachmentId as ImageAttachmentRef['attachmentId'],
      mediaType: shot.mediaType,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes,
    },
  }
  return [image, { type: 'text', text: `screenshot ${shot.width}x${shot.height} png` }]
}

/** Canonical value from a saved attachment reference. */
function screenshotValue(ref: ImageAttachmentRef): ComputerScreenshotValue {
  return {
    attachmentId: ref.attachmentId,
    mediaType: 'image/png',
    width: ref.width,
    height: ref.height,
    bytes: ref.bytes,
  }
}
