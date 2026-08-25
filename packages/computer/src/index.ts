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
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `COMPUTER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `COMPUTER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `COMPUTER_PROVIDER_UNAVAILABLE`.
 */
export class ComputerRuntime extends Service {
  static Config: z<ComputerRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, ComputerProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: ComputerRuntimeConfig = {}) {
    super(ctx, 'computer')
    this.providerId = config.provider ?? process.env.DSH_COMPUTER_PROVIDER
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
    return resolveProvider(this.providers, this.providerId).snapshot(signal)
  }

  /** @returns the navigation outcome from the selected provider. */
  async navigate(url: string, signal?: AbortSignal): Promise<ComputerNavigation> {
    return resolveProvider(this.providers, this.providerId).navigate(url, signal)
  }

  /** @returns the click outcome from the selected provider. */
  async click(index: number, signal?: AbortSignal): Promise<ComputerClickResult> {
    return resolveProvider(this.providers, this.providerId).click(index, signal)
  }

  /** @returns the text-input outcome from the selected provider. */
  async type(index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult> {
    return resolveProvider(this.providers, this.providerId).type(index, text, signal)
  }

  /** @returns the key-press outcome from the selected provider. */
  async pressKey(key: string, signal?: AbortSignal): Promise<ComputerKeyPressResult> {
    return resolveProvider(this.providers, this.providerId).pressKey(key, signal)
  }

  /** @returns the screenshot from the selected provider. */
  async screenshot(signal?: AbortSignal): Promise<ComputerScreenshot> {
    return resolveProvider(this.providers, this.providerId).screenshot(signal)
  }
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
