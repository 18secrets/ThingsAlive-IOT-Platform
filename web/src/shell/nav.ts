import type { Capability } from '../lib/types';

export type NavItem = {
  path: string;
  label: string;
  /** The capability that puts this screen on the rail — and the one its API requires. */
  needs: Capability;
  /** What the screen reads. Kept here so a screen with no route behind it is obvious. */
  route: string;
};

/**
 * The Things Alive console. Authoring and commerce: what the product is, who has
 * bought it, and which hardware is out there.
 */
export const THINGS_ALIVE: NavItem[] = [
  { path: '/accounts', label: 'Accounts', needs: 'tenant.provision', route: 'GET /accounts' },
  { path: '/catalog', label: 'Catalog', needs: 'catalog.write', route: 'GET /catalog/authoring/equipment-classes' },
  { path: '/entitlements', label: 'Entitlements', needs: 'entitlement.grant', route: 'GET /catalog/entitlements' },
  { path: '/device-pool', label: 'Device pool', needs: 'device.manage', route: 'GET /inventory/pool' },
  { path: '/signal-aliases', label: 'Signal aliases', needs: 'catalog.write', route: 'POST /catalog/signal-aliases' },
];

/**
 * The client console. One account's own machines, and what the platform has worked
 * out about them.
 */
export const CLIENT: NavItem[] = [
  // Predictions are per machine — `GET /predictions/:sourceSystem/:externalId` — and
  // there is no fleet-wide roll-up route. Writing 'GET /predictions' here was wrong and
  // is exactly what this column exists to catch: Overview is built from the routes that
  // are fleet-shaped, and a roll-up is tracked as backend work rather than assumed.
  { path: '/overview', label: 'Overview', needs: 'prediction.read', route: 'GET /alerts + GET /utilization/summary' },
  // Keyed to the capability the screen's own read needs, not the one its buttons need.
  // Everybody in an account may see the register; the roles that hold `equipment.write`
  // additionally get the controls. A support engineer gets the same screen without the
  // buttons rather than a different screen, or a wall of disabled ones.
  { path: '/equipment', label: 'Equipment', needs: 'catalog.read', route: 'GET /equipment, GET /equipment/plants' },
  { path: '/alerts', label: 'Alerts', needs: 'prediction.read', route: 'GET /alerts, GET /alerts/rules' },
  { path: '/activations', label: 'Activations', needs: 'scenario.activate', route: 'GET /activations' },
  { path: '/devices', label: 'Devices', needs: 'device.read', route: 'GET /inventory/mine, GET /device-health' },
  { path: '/people', label: 'People', needs: 'user.manage', route: 'GET /identity/users, GET /identity/roles' },
  { path: '/work', label: 'Work orders', needs: 'action.work', route: 'GET /work-orders' },
];

/**
 * A caller sees the console their capabilities describe.
 *
 * Hidden rather than disabled, and hidden by capability rather than by role: a screen
 * nobody has classified goes missing instead of becoming public, which is the failure
 * worth having. The two lists are concatenated rather than switched between, so a
 * token that somehow held both would show both rather than silently picking one.
 */
export function navFor(
  can: Record<Capability, boolean>,
  isPlatformRole: boolean,
): NavItem[] {
  // A platform role holds no row in any customer account and resolves to no tenant, so
  // every screen below reads tenant-owned data it has no scope for. The capability map
  // does grant a few of them — `catalog.read` and `device.read` name platform roles —
  // but a capability is permission to do a thing, not the existence of data to do it
  // to, and a rail entry that opens onto a guaranteed empty screen is a worse lie than
  // a missing one. Support looking into one customer's account is its own screen, with
  // the account named and the access audited.
  const reachable = isPlatformRole ? THINGS_ALIVE : [...THINGS_ALIVE, ...CLIENT];
  return reachable.filter((item) => can[item.needs]);
}
