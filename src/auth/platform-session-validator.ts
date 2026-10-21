/**
 * How the guard asks whether a platform session is still good (task QPA1).
 *
 * An interface and a token rather than a direct dependency, for the same reason
 * `ScopeResolver` is one: the auth module cannot import the identity module, since the
 * guard is the thing identity is protected by.
 *
 * It is optional, and only consulted when the token itself carries a session id. A
 * platform token with no session id — the CLI-minted bootstrap token from
 * `mint-token.ts` — was never state-backed and keeps working exactly as it always has,
 * whether or not a validator is wired in.
 */
export interface PlatformSessionValidator {
  /** False for a revoked session, an unrecognised one, or a suspended account. */
  isSessionUsable(sessionId: string): Promise<boolean>;
}

export const PLATFORM_SESSION_VALIDATOR = Symbol('ta:platform-session-validator');
