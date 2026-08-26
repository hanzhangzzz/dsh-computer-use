/**
 * Which applications the model may drive.
 *
 * The shape follows Codex's, which is per-application with a configurable
 * default (`codex-rs/config/src/computer_use.rs`: `default_app_access` plus a
 * `bundle_ids` map). The default here is `allow`, deliberately.
 *
 * A default-deny list was the first design and it was wrong. It makes the
 * plugin do nothing until configured, and the usual response to that friction
 * is to allow everything — which leaves the friction and removes the safety. It
 * would also have been aimed at the wrong thing: the unattended incident of
 * 2026-08-25 escalated through bash, not through the computer tools, so no
 * application policy would have touched it.
 *
 * What actually keeps a wrong action from happening is elsewhere and already
 * built: actions carry the identity the caller expected and are refused when
 * the live element no longer matches, and nothing ever steals focus or moves
 * the cursor, so the user can see and interrupt.
 *
 * So this list is a floor, not a fence: the few applications where one wrong
 * press cannot be undone. It cannot be complete — a password manager or a
 * banking app is just as unrecoverable and is not enumerable — which is the
 * honest reason not to lean on it as the primary guard.
 */

/** Access decision for one application. */
export type AppAccess = 'allow' | 'deny'

/**
 * Applications denied unless the operator opts back in, each for a reason that
 * survives "the model is usually careful".
 */
export const DEFAULT_DENIED: Readonly<Record<string, string>> = {
  // Arbitrary command execution. The 2026-08-25 incident reached a terminal
  // through osascript; driving one through the accessibility tree is the same
  // capability with a nicer interface.
  'com.apple.Terminal': 'a terminal runs arbitrary commands',
  'com.googlecode.iterm2': 'a terminal runs arbitrary commands',
  // Can revoke or grant the very permissions this plugin depends on, and can
  // change security settings the user cannot easily notice.
  'com.apple.systempreferences': 'System Settings can alter security and permissions',
  // Credentials.
  'com.apple.keychainaccess': 'Keychain Access exposes stored credentials',
  // Outbound messages cannot be recalled.
  'com.apple.mail': 'sending mail is irreversible',
  'com.apple.MobileSMS': 'sending a message is irreversible',
}

/** Config for the access policy. */
export interface AccessConfig {
  /** Access for applications not named in {@link apps}. Defaults to `allow`. */
  readonly defaultAppAccess?: AppAccess
  /** Per-bundle-id overrides. Wins over both the default and {@link DEFAULT_DENIED}. */
  readonly apps?: Readonly<Record<string, AppAccess>>
}

/** Outcome of an access check, carrying the reason so the model can report it. */
export interface AccessDecision {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Decide whether one application may be driven.
 *
 * Precedence is explicit-over-implicit: an operator's entry for this exact
 * bundle id wins, then the built-in denials, then the configured default.
 * @param bundleId - the application's bundle identifier.
 * @param config - the operator's policy.
 */
export function checkAccess(bundleId: string, config: AccessConfig = {}): AccessDecision {
  const explicit = config.apps?.[bundleId]
  if (explicit !== undefined) {
    return explicit === 'allow'
      ? { allowed: true, reason: 'allowed by configuration' }
      : { allowed: false, reason: `denied by configuration` }
  }

  const builtIn = DEFAULT_DENIED[bundleId]
  if (builtIn !== undefined) {
    return {
      allowed: false,
      reason: `${bundleId} is denied by default because ${builtIn}; if this is intended, set provider.macos.apps["${bundleId}"] to "allow"`,
    }
  }

  const fallback = config.defaultAppAccess ?? 'allow'
  return fallback === 'allow'
    ? { allowed: true, reason: 'allowed by default' }
    : { allowed: false, reason: `${bundleId} is not in provider.macos.apps and the default is deny` }
}
