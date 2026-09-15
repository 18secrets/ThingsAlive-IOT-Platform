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
  { path: '/catalog', label: 'Catalog', needs: 'catalog.write', route: 'GET /catalog/equipment-classes' },
  { path: '/entitlements', label: 'Entitlements', needs: 'entitlement.grant', route: 'GET /catalog/entitlements' },
  { path: '/device-pool', label: 'Device pool', needs: 'device.manage', route: 'GET /inventory/pool' },
];

/**
 * The client console. One account's own machines, and what the platform has worked
 * out about them.
 */
export const CLIENT: NavItem[] = [
  { path: '/overview', label: 'Overview', needs: 'prediction.read', route: 'GET /predictions' },
  { path: '/equipment', label: 'Equipment', needs: 'equipment.write', route: 'GET /equipment' },
  { path: '/alerts', label: 'Alerts', needs: 'alert.author', route: 'GET /alerts' },
  { path: '/activations', label: 'Activations', needs: 'scenario.activate', route: 'GET /activations' },
  { path: '/devices', label: 'Devices', needs: 'device.read', route: 'GET /inventory/mine' },
  { path: '/people', label: 'People', needs: 'user.manage', route: 'GET /identity/users' },
];

/**
 * A caller sees the console their capabilities describe.
 *
 * Hidden rather than disabled, and hidden by capability rather than by role: a screen
 * nobody has classified goes missing instead of becoming public, which is the failure
 * worth having. The two lists are concatenated rather than switched between, so a
 * token that somehow held both would show both rather than silently picking one.
 */
export function navFor(can: Record<Capability, boolean>): NavItem[] {
  return [...THINGS_ALIVE, ...CLIENT].filter((item) => can[item.needs]);
}
