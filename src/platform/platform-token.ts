import { JwtService } from '@nestjs/jwt';
import { PLATFORM_ROLES, PlatformRole, isPlatformRole } from '../auth/platform-roles';

/**
 * The first credential, and the only one 2.0 issues for itself (task D-11).
 *
 * Everything a customer's people do starts with a sign-in, and every sign-in starts
 * with a user row — but Things Alive staff hold no row in any account. The auth guard
 * short-circuits scope resolution for a platform role and reads the token instead, so
 * a platform caller's authority *is* their token and nothing in the platform mints
 * one. That is the chicken and egg this closes: without it a freshly deployed
 * platform has no way to create its first account, because creating an account needs
 * `tenant.provision`, which needs `master-admin`, which needs a token nobody can make.
 *
 * It is deliberately a script and not a route. A route that hands out platform
 * authority is a route somebody will eventually reach; this needs the signing secret,
 * which means shell access to the running service, which is the same thing as being
 * able to read the database anyway.
 */
export interface MintInput {
  role: string;
  /** Who this is, for the audit trail: every provisioned account records it. */
  subject: string;
  /**
   * The tenant claim. A platform role acts across accounts, so this is not an account
   * they belong to — but the guard refuses a token without one, because a missing
   * tenant treated as "all tenants" is how a bug becomes a cross-customer leak.
   */
  tenantId?: string;
  /** Minutes. Short by default: a standing platform key is the thing to avoid. */
  expiresInMinutes?: number;
}

export interface MintOptions {
  secret?: string;
  issuer?: string;
  tenantClaim?: string;
}

export const DEFAULT_EXPIRY_MINUTES = 12 * 60;
export const MAX_EXPIRY_MINUTES = 7 * 24 * 60;
export const DEFAULT_PLATFORM_TENANT = 'things-alive';

/**
 * Secrets that mean "nobody chose one". Minting against any of them would produce a
 * token that works locally, works in CI, and is forgeable by anyone who has read the
 * repository — which is everyone.
 */
const PLACEHOLDER_SECRETS = new Set([
  'ci-test-secret', 'test-secret', 'secret', 'changeme', 'change-me', 'password',
]);

export class MintRefusal extends Error {}

export interface MintedToken {
  token: string;
  role: PlatformRole;
  subject: string;
  tenantId: string;
  issuer?: string;
  expiresAt: Date;
}

export function mintPlatformToken(
  input: MintInput,
  options: MintOptions = {},
  now: Date = new Date(),
): MintedToken {
  const role = input.role?.trim().toLowerCase() ?? '';
  if (!isPlatformRole(role)) {
    // Not a generic validation message: a token carrying 'admin' would verify, carry
    // a role, resolve no capabilities and fail every route with 403 — which reads as
    // a permissions bug rather than as the wrong word in a command.
    throw new MintRefusal(
      `"${input.role}" is not a platform role. One of: ${PLATFORM_ROLES.join(', ')}.`,
    );
  }

  const subject = input.subject?.trim();
  if (!subject) {
    throw new MintRefusal('A subject is required — it is what the audit trail records.');
  }

  const secret = options.secret?.trim();
  if (!secret) {
    throw new MintRefusal('AUTH_JWT_SECRET is not set. Run this where the service runs.');
  }
  if (PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    throw new MintRefusal(
      'AUTH_JWT_SECRET is a placeholder value, so this token would be forgeable by ' +
      'anyone who has read the repository. Set a real secret first.',
    );
  }

  const minutes = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new MintRefusal('Expiry must be a positive number of minutes.');
  }
  if (minutes > MAX_EXPIRY_MINUTES) {
    // A platform token is unrevocable — there is no row to suspend and no session to
    // end, so the expiry is the only thing that ever takes it away.
    throw new MintRefusal(
      `Expiry is capped at ${MAX_EXPIRY_MINUTES} minutes (7 days). A platform token ` +
      'cannot be revoked; expiry is the only thing that ends it.',
    );
  }

  const tenantClaim = options.tenantClaim?.trim() || 'client_id';
  const tenantId = input.tenantId?.trim() || DEFAULT_PLATFORM_TENANT;
  const expiresAt = new Date(now.getTime() + minutes * 60_000);

  // `issuer: undefined` is rejected outright rather than ignored, so the key has to
  // be absent when there is no issuer — not present and empty.
  const issuer = options.issuer?.trim() || undefined;
  const token = new JwtService({}).sign(
    { sub: subject, [tenantClaim]: tenantId, roles: [role] },
    { secret, expiresIn: `${Math.round(minutes)}m`, ...(issuer ? { issuer } : {}) },
  );

  return { token, role, subject, tenantId, issuer, expiresAt };
}
