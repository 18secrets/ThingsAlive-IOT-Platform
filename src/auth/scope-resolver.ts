/**
 * How the guard asks 2.0 who the caller is (task P1-84).
 *
 * An interface and a token rather than a direct dependency, because the auth module
 * must not import the identity module: the guard is the thing identity is protected
 * by, and a cycle between them is the kind that ends in a partially-initialised
 * provider and a guard that silently allows everything.
 *
 * It is optional. Without a resolver the guard falls back to what the token says,
 * which is how the isolation and contract suites run without an identity database.
 */
export interface ResolvedIdentity {
  roles: string[];
  capabilities: readonly string[];
  /** undefined means unrestricted within the account; [] matches nothing. */
  plantIds?: readonly string[];
  equipmentIds?: readonly string[];
}

export interface ScopeResolver {
  /** Null when this caller has no row in the account — a platform role, typically. */
  resolve(tenantId: string, userId: string): Promise<ResolvedIdentity | null>;
}

export const SCOPE_RESOLVER = Symbol('ta:scope-resolver');
