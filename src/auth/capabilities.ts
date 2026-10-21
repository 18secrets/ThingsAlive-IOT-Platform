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
  | 'role.manage'
  | 'tenant.provision'
  | 'equipment.write'
  | 'scenario.activate'
  | 'scenario.author'
  | 'alert.author'
  | 'action.work'
  | 'catalog.read'
  | 'catalog.write'
  | 'client-catalog.read'
  | 'client-catalog.write'
  | 'device.manage'
  | 'device.read'
  | 'device.claim'
  | 'prediction.read'
  | 'prediction.run'
  | 'entitlement.grant'
  | 'platform.admin';

/** The four consumer roles, plus the Things Alive roles that act across tenants. */
const GRANTS: Record<Capability, readonly string[]> = {
  'tenant.manage': ['super admin', 'master-admin'],
  // The account's own users. Super admin alone: a master admin adding a user to a
  // client account would be Things Alive deciding who works for a customer, which is
  // the same boundary that keeps them out of the client's catalog copies.
  'user.manage': ['super admin'],
  // The account's own roles. Roles are rows rather than code, so a client can add the
  // ones they need — composed from the capability list below, which they cannot add to.
  'role.manage': ['super admin'],
  // Creating an account and seeding its first super admin. The one user-shaped thing
  // Things Alive does do, because somebody has to exist before anybody can be invited.
  'tenant.provision': ['master-admin'],
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
  // Authoring the *templates*. Things Alive only: the catalog is what Things Alive
  // sells, and a customer editing it would be editing the product.
  'catalog.write': ['master-admin', 'catalog-author'],
  // Reading the *client's own copies*. Every role inside the tenant; Things Alive
  // roles are absent on purpose — a platform role reaching a client's copy goes
  // through the audited cross-tenant path, not through an ordinary read.
  'client-catalog.read': ['super admin', 'admin', 'operational', 'support'],
  // Editing them. Super admin alone. Once a class is granted, the copy is the
  // client's and nobody at Things Alive can write it, which is why no platform role
  // appears in this list and why adding one later would be a change of model rather
  // than a change of permission.
  'client-catalog.write': ['super admin'],
  // The pool is Things Alive's stock ledger. Registering, assigning, releasing and
  // retiring are commercial acts, and none of them are a customer's to perform on
  // hardware they are renting.
  'device.manage': ['master-admin'],
  // Seeing the devices in your own account. Every role inside the tenant, because
  // "which loggers do we have" is not a privileged question about your own kit.
  'device.read': [
    'super admin', 'admin', 'operational', 'support',
    'master-admin', 'platform-support',
  ],
  // Fitting a device to a machine and taking it off again. The customer's act, not
  // ours — nobody at Things Alive knows which generator the logger ended up on.
  'device.claim': ['super admin', 'admin'],
  // Predictions are the product the customer bought, so every role inside the tenant
  // reads them. Support is included because the first question on any ticket is what
  // the platform actually said about the machine, and asking the customer to read it
  // back is how the wrong number gets diagnosed.
  'prediction.read': ['super admin', 'admin', 'operational', 'support', 'platform-support'],
  // Re-running the scorer by hand. Narrow deliberately: it is cheap but it rewrites a
  // stored outcome, and an outcome that changes without an explanation is worse than
  // a stale one.
  'prediction.run': ['super admin', 'admin'],
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
  const out = {} as Record<Capability, boolean>;

  // A client user's capabilities come from their account's own role row, because a
  // client can now define roles Things Alive has never heard of. The table below is
  // still the authority for platform roles, which are ours and are not rows.
  //
  // The two cannot drift into disagreement, because they are never consulted for the
  // same caller: a resolved role wins outright rather than being merged with the
  // table. Merging would mean a client could not take a capability away, since the
  // static grant would keep handing it back.
  if (scope.capabilities) {
    const held = new Set<string>(scope.capabilities);
    for (const capability of Object.keys(GRANTS) as Capability[]) {
      out[capability] = held.has(capability);
    }
    return out;
  }

  const roles = new Set(scope.roles);
  for (const [capability, granted] of Object.entries(GRANTS) as [Capability, string[]][]) {
    out[capability] = granted.some((r) => roles.has(r));
  }
  return out;
}

export function can(scope: RequestScope, capability: Capability): boolean {
  return capabilitiesFor(scope)[capability] === true;
}

export const ALL_CAPABILITIES = Object.keys(GRANTS) as Capability[];
