import { RequestScope } from './types/request-scope';

/**
 * Everything a caller can be permitted to do, named once (tasks P1-57, P1-58).
 *
 * A union rather than free strings, so a typo in a guard is a compile error instead
 * of a permission that is silently never granted — the failure mode where a screen
 * quietly disappears for everyone and nobody can say why.
 */
export type Capability =
  | 'tenant.manage'
  | 'user.manage'
  | 'equipment.write'
  | 'scenario.activate'
  | 'scenario.author'
  | 'alert.author'
  | 'action.work'
  | 'catalog.read'
  | 'catalog.write'
  | 'entitlement.grant'
  | 'platform.admin';

/** The four consumer roles, plus the Things Alive roles that act across tenants. */
const GRANTS: Record<Capability, readonly string[]> = {
  'tenant.manage': ['super admin', 'master-admin'],
  'user.manage': ['super admin', 'master-admin'],
  'equipment.write': ['super admin', 'admin', 'master-admin'],
  'scenario.activate': ['super admin', 'admin'],
  'scenario.author': ['super admin', 'admin'],
  'alert.author': ['super admin', 'admin'],
  'action.work': ['super admin', 'admin', 'operational', 'support'],
  // Everyone inside a tenant may see the catalog. What they see is narrowed by the
  // entitlement join, not by the role — those are different questions and conflating
  // them is how a role ends up silently granting access to an unpurchased class.
  'catalog.read': [
    'super admin', 'admin', 'operational', 'support',
    'master-admin', 'catalog-author', 'platform-support',
  ],
  'catalog.write': ['master-admin', 'catalog-author'],
  'entitlement.grant': ['master-admin'],
  'platform.admin': ['master-admin'],
};

/**
 * The single answer to "what may this caller do".
 *
 * Both the guard and `/me/permissions` call this. They must not be two lists that
 * happen to agree today: the moment they disagree, the UI offers a control the API
 * refuses, or hides one it would have allowed, and either bug is invisible until a
 * customer hits it.
 */
export function capabilitiesFor(scope: RequestScope): Record<Capability, boolean> {
  const roles = new Set(scope.roles);
  const out = {} as Record<Capability, boolean>;
  for (const [capability, granted] of Object.entries(GRANTS) as [Capability, string[]][]) {
    out[capability] = granted.some((r) => roles.has(r));
  }
  return out;
}

export function can(scope: RequestScope, capability: Capability): boolean {
  return capabilitiesFor(scope)[capability] === true;
}

export const ALL_CAPABILITIES = Object.keys(GRANTS) as Capability[];
