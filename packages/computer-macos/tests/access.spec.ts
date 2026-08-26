/**
 * The application access policy. Pins the two decisions that were argued over:
 * the default is permissive, and the built-in denials are a short list of
 * unrecoverable cases rather than a gate everything must pass.
 */
import { describe, expect, test } from 'vitest'
import { checkAccess, DEFAULT_DENIED } from '../src/access.ts'

describe('application access policy', () => {
  test('an ordinary application is allowed with no configuration at all', () => {
    const decision = checkAccess('com.github.Electron')
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed by default')
  })

  test('the built-in denials cover the cases one wrong press cannot undo', () => {
    for (const bundleId of Object.keys(DEFAULT_DENIED)) {
      expect(checkAccess(bundleId).allowed).toBe(false)
    }
    // Spot-check the two that motivated the list.
    expect(checkAccess('com.apple.Terminal').allowed).toBe(false)
    expect(checkAccess('com.apple.mail').allowed).toBe(false)
  })

  test('a denial says why and how to override it, rather than just refusing', () => {
    const decision = checkAccess('com.apple.Terminal')
    expect(decision.reason).toContain('arbitrary commands')
    expect(decision.reason).toContain('provider.macos.apps["com.apple.Terminal"]')
  })

  test('an explicit allow beats the built-in denial', () => {
    const decision = checkAccess('com.apple.Terminal', { apps: { 'com.apple.Terminal': 'allow' } })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed by configuration')
  })

  test('an explicit deny beats a permissive default', () => {
    expect(checkAccess('com.apple.finder', { apps: { 'com.apple.finder': 'deny' } }).allowed).toBe(false)
  })

  test('the whole policy can be flipped to deny-by-default for a stricter deployment', () => {
    const strict = { defaultAppAccess: 'deny' as const, apps: { 'com.github.Electron': 'allow' as const } }
    expect(checkAccess('com.github.Electron', strict).allowed).toBe(true)
    expect(checkAccess('com.apple.finder', strict).allowed).toBe(false)
    expect(checkAccess('com.apple.finder', strict).reason).toContain('the default is deny')
  })

  test('an explicit entry still wins under deny-by-default', () => {
    // Precedence must be one rule in both directions, not a special case.
    const strict = { defaultAppAccess: 'deny' as const, apps: { 'com.apple.Terminal': 'allow' as const } }
    expect(checkAccess('com.apple.Terminal', strict).allowed).toBe(true)
  })
})
