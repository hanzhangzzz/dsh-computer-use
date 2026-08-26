/**
 * Service Definition for the computer use capability seam (`ctx.computer`):
 * the provider registry and provider-selecting execution for structure-first
 * interaction with one surface. Mirrors the dsh-web selection semantics —
 * resolved at execution time, never registration-order dependent.
 * @module dsh-computer
 */

import { Context, Service } from '@deepseek-ai/cordis'
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
} from './types.ts'
import { ComputerError } from './types.ts'

export { ComputerError } from './types.ts'
export type {
  ComputerClickResult,
  ComputerElement,
  ComputerKeyPressResult,
  ComputerNavigation,
  ComputerProvider,
  ComputerScreenshot,
  ComputerSnapshot,
  ComputerSurface,
  ComputerTypeResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computer: ComputerRuntime
  }
}

/**
 * Config for the computer seam. `provider` pins which registered provider
 * wins; omitted auto-selects when exactly one usable provider is registered.
 */
export interface ComputerRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The computer use service, registered as `ctx.computer` (one instance per
 * context).
 *
 * Selection semantics (execution-time, order-independent):
 * - A focused surface → the provider whose id prefixes that surface id.
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `COMPUTER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `COMPUTER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `COMPUTER_PROVIDER_UNAVAILABLE`.
 *
 * The ambiguity error survives on purpose: it is what a caller sees when two
 * providers are mounted and nothing has been focused yet. {@link focus} is the
 * way out of it, and {@link surfaces} is how the caller learns the choices.
 */
export class ComputerRuntime extends Service {
  static Config: z<ComputerRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, ComputerProvider>()
  private readonly providerId: string | undefined
  /** Surface selected by {@link focus}; routes every later action. */
  private focused: string | undefined

  constructor(ctx: Context, config: ComputerRuntimeConfig = {}) {
    super(ctx, 'computer')
    this.providerId = config.provider ?? process.env.DSH_COMPUTER_PROVIDER
  }

  /**
   * Every surface across every usable provider, provider-id then surface-id
   * ordered so the list never depends on registration order.
   * @returns the aggregated surfaces; a provider that fails to enumerate is
   * skipped rather than failing the whole listing.
   */
  async surfaces(signal?: AbortSignal): Promise<readonly ComputerSurface[]> {
    const usable = [...this.providers.values()]
      .filter(provider => provider.available())
      .sort((a, b) => a.id.localeCompare(b.id))
    const collected: ComputerSurface[] = []
    for (const provider of usable) {
      // One unreachable provider (a desktop app that just quit) must not hide
      // the surfaces of the others — listing is how a caller recovers.
      const found = await provider.surfaces(signal).catch(() => [])
      collected.push(...[...found].sort((a, b) => a.id.localeCompare(b.id)))
    }
    return collected
  }

  /**
   * Select the surface every later action targets.
   * @param surfaceId - an id from {@link surfaces}; its prefix names the provider.
   * @returns the focused surface as the provider reports it.
   */
  async focus(surfaceId: string, signal?: AbortSignal): Promise<ComputerSurface> {
    const provider = routeSurface(this.providers, surfaceId)
    const surface = await provider.focus(surfaceId, signal)
    this.focused = surfaceId
    return surface
  }

  /** The currently focused surface id, if any. */
  get focusedSurface(): string | undefined {
    return this.focused
  }

  /** Route by focused surface when set, else fall back to single-provider selection. */
  private select(): ComputerProvider {
    if (this.focused !== undefined) return routeSurface(this.providers, this.focused)
    return resolveProvider(this.providers, this.providerId)
  }

  /**
   * Register a computer use provider. Throws {@link ComputerError}
   * `COMPUTER_DUPLICATE_PROVIDER` if the id is already registered. The
   * provider's `close()` runs on dispose of the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: ComputerProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new ComputerError(`a computer provider with id "${provider.id}" is already registered`, 'COMPUTER_DUPLICATE_PROVIDER')
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => {
        store.delete(provider.id)
        // close() is the provider's own quiescence; failures are its concern.
        void provider.close()
      }
    }, 'computer.registerProvider()')
    return () => void dispose()
  }

  /** @returns the snapshot from the selected provider. */
  async snapshot(signal?: AbortSignal): Promise<ComputerSnapshot> {
    return this.select().snapshot(signal)
  }

  /** @returns the navigation outcome from the selected provider. */
  async navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation> {
    return this.select().navigate(url, signal)
  }

  /** @returns the click outcome from the selected provider. */
  async click(index: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    return this.select().click(index, signal)
  }

  /** @returns the text-input outcome from the selected provider. */
  async type(index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult> {
    return this.select().type(index, text, signal)
  }

  /** @returns the coordinate-click outcome from the selected provider. */
  async clickAt(x: number, y: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    return this.select().clickAt(x, y, signal)
  }

  /** @returns the key-press outcome from the selected provider. */
  async pressKey(key: string, signal?: AbortSignal): Promise<ComputerKeyPressResult> {
    return this.select().pressKey(key, signal)
  }

  /** @returns the screenshot from the selected provider. */
  async screenshot(signal?: AbortSignal): Promise<ComputerScreenshot> {
    return this.select().screenshot(signal)
  }
}

/**
 * Route a surface id to its owning provider. The id's prefix before the first
 * colon is the provider id, so routing is a pure function of the id — never of
 * registration order, which is the property the ambiguity error exists to
 * protect.
 */
function routeSurface(
  providers: ReadonlyMap<string, ComputerProvider>,
  surfaceId: string,
): ComputerProvider {
  const separator = surfaceId.indexOf(':')
  const providerId = separator === -1 ? surfaceId : surfaceId.slice(0, separator)
  const provider = providers.get(providerId)
  if (provider === undefined) {
    throw new ComputerError(`no computer provider owns surface "${surfaceId}"`, 'COMPUTER_SURFACE_UNROUTABLE')
  }
  if (!provider.available()) {
    throw new ComputerError(`the provider owning surface "${surfaceId}" is unavailable`, 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE')
  }
  return provider
}

/** Resolve the selected provider or throw the matching {@link ComputerError}. */
function resolveProvider(
  providers: ReadonlyMap<string, ComputerProvider>,
  configuredId: string | undefined,
): ComputerProvider {
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new ComputerError(`configured computer provider "${configuredId}" is not registered`, 'COMPUTER_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new ComputerError(`configured computer provider "${configuredId}" is registered but unavailable`, 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new ComputerError('no usable computer provider is registered', 'COMPUTER_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new ComputerError(`multiple usable computer providers are registered (${ids}); configure one explicitly`, 'COMPUTER_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default ComputerRuntime
