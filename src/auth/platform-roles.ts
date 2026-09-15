/**
 * The roles that act across accounts — Things Alive staff rather than a customer's
 * people (task P1-57).
 *
 * Defined once because two places need the same answer and they must not drift. The
 * auth guard uses it to decide whether to resolve scope from the database at all: a
 * platform caller holds no row in any customer's account, so there is nothing to
 * resolve and the token is the whole story. The token minter uses it to refuse to
 * mint a role the guard would not recognise — which would otherwise produce a token
 * that verifies, carries a role, and grants nothing, with no error anywhere.
 */
export const PLATFORM_ROLES = ['master-admin', 'platform-support', 'catalog-author'] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_ROLE_SET: ReadonlySet<string> = new Set(PLATFORM_ROLES);

export function isPlatformRole(role: string): role is PlatformRole {
  return PLATFORM_ROLE_SET.has(role);
}
