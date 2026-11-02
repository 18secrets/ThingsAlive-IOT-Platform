import { AdminSubTab, AuthUser, NavigationTab } from '../types';

/**
 * Which pages a signed-in person may open — one answer for the sidebar, the
 * Administration tab bar and the route guard in Shell, so a page hidden from the
 * menu cannot still be reached by its address or a link (tester report, 27 Oct 2026).
 *
 * - A client user opens the pages their role grants (`allowedTabs`); the account's
 *   Super Admin opens every client page, and only they open Client Users and Roles.
 * - Things Alive staff open what their own role's capabilities allow. Before this,
 *   every staff member was shown as Master Admin, and a Catalog Author or Platform
 *   Support person met screens whose every call the API then refused.
 *
 * The API enforces the same capabilities on every call; this only keeps the screens
 * from offering what the API will refuse.
 */

/** The capability a staff member needs for each Administration sub-tab — the one its list endpoint requires. */
const STAFF_ADMIN_CAPABILITY: Record<AdminSubTab | 'catalog-import', string | null> = {
  industry: 'device-catalog.write',
  sensor: 'device-catalog.read',
  category: 'catalog.read',
  'named-formula': 'catalog.write',
  'tool-mapping': 'device-catalog.read',
  'signal-alias': 'catalog.write',
  'signal-state': 'device-catalog.read',
  'telemetry-archive': 'platform.admin',
  'catalog-import': 'catalog.write',
  clients: 'tenant.provision',
  staff: 'platform.admin',
  devices: 'device.manage',
  equipment: 'catalog.read',
  plant: null,
};

/** The page each client path belongs to, for the role check. */
function clientTabOf(first: string): NavigationTab | null {
  switch (first) {
    case 'dashboard':
    case 'equipment':
    case 'sites':
    // The geofence map (QGEO2) is a view of the same fleet; the API scopes its rows.
    case 'geofence':
      // A machine's or site's page is reached from the dashboard and goes with it.
      return 'dashboard';
    case 'alert-agent':
      return 'alerts';
    case 'things-care': case 'things-shield': case 'incident-management': case 'production-monitoring':
    case 'ai-onboarding': case 'alerts': case 'predictions': case 'scenarios': case 'work-orders':
    case 'cost-administration': case 'admin': case 'settings': case 'client-users': case 'roles':
      return first;
    default:
      return null;
  }
}

function staffCan(user: AuthUser, capability: string): boolean {
  return user.capabilities?.[capability] === true;
}

export function canOpenAdminSubTab(user: AuthUser, subTab: AdminSubTab | 'catalog-import'): boolean {
  if (user.role === 'client') return true;
  const capability = STAFF_ADMIN_CAPABILITY[subTab];
  return capability !== null && capability !== undefined && staffCan(user, capability);
}

export function canOpenPath(user: AuthUser, pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const [first = '', second = ''] = parts;
  if (!first) return true;
  // A machine's or site's own page lives under /admin/equipment/…/page and
  // /admin/sites/…/page, but it is reached from the dashboard and the daily pages,
  // not from Administration's list.
  const isMachineOrSitePage = first === 'admin' && (second === 'equipment' || second === 'sites') && parts.length > 2;

  if (user.role === 'client') {
    const tab = isMachineOrSitePage ? 'dashboard' : clientTabOf(first);
    if (!tab) return true; // not a page; the router's own fallback answers it
    if (tab === 'client-users' || tab === 'roles') return !!user.isSuperAdmin;
    if (user.isSuperAdmin) return true;
    return (user.allowedTabs ?? []).includes(tab);
  }

  // Things Alive staff. The platform dashboard is account and logger-pool totals,
  // all read under Master Admin's capabilities; anyone else saw zeros and errors.
  if (first === 'settings') return true;
  if (first === 'dashboard') return staffCan(user, 'tenant.provision');
  if (first === 'admin') {
    if (!second) return firstAllowedAdminSubTab(user) !== null;
    if (isMachineOrSitePage) return staffCan(user, 'catalog.read');
    if (second === 'devices') return staffCan(user, 'device.manage'); // and devices/new
    if (second === 'category') return staffCan(user, 'catalog.read'); // and a class's own page
    return canOpenAdminSubTab(user, second as AdminSubTab);
  }
  if (first === 'equipment' || first === 'sites') return staffCan(user, 'catalog.read');
  // Anything else is a client's page, which only Master Admin has ever reached.
  return staffCan(user, 'platform.admin');
}

/** The sidebar entry's own address, for the same check. */
export function pathOfTab(tab: NavigationTab): string {
  if (tab === 'clients' || tab === 'staff' || tab === 'devices' || tab === 'equipment') return `/admin/${tab}`;
  return `/${tab}`;
}

export function canOpenTab(user: AuthUser, tab: NavigationTab): boolean {
  return canOpenPath(user, pathOfTab(tab));
}

/** Administration's tab bar order, per side — the first one the person may open. */
const STAFF_ADMIN_ORDER: AdminSubTab[] = [
  'industry', 'category', 'named-formula', 'sensor', 'tool-mapping', 'signal-alias', 'signal-state', 'telemetry-archive',
];

export function firstAllowedAdminSubTab(user: AuthUser): AdminSubTab | null {
  if (user.role === 'client') return 'plant';
  return STAFF_ADMIN_ORDER.find((s) => canOpenAdminSubTab(user, s)) ?? null;
}

/** Where to land someone whose landing page (or the page they asked for) is not theirs. */
const LANDING_ORDER: NavigationTab[] = [
  'dashboard', 'things-care', 'things-shield', 'incident-management', 'production-monitoring', 'ai-onboarding',
  'alerts', 'predictions', 'scenarios', 'work-orders', 'cost-administration', 'admin', 'settings',
];

export function firstAllowedPath(user: AuthUser): string | null {
  const tab = LANDING_ORDER.find((t) => canOpenTab(user, t));
  if (!tab) return null;
  if (tab === 'admin') return `/admin/${firstAllowedAdminSubTab(user)}`;
  return pathOfTab(tab);
}
