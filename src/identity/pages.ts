/**
 * The pages a client's own role can be granted (task: role page access).
 *
 * A closed vocabulary, same reasoning as `ALL_CAPABILITIES`: a role naming a page
 * the frontend has never heard of would look granted and do nothing. Kept separate
 * from capabilities on purpose — this gates what a role's sidebar shows, not what
 * the API allows, and a page can be backed by several different capabilities.
 *
 * 'client-users' and 'roles' are deliberately absent: those are structural, driven
 * by whether a role holds `user.manage`/`role.manage`, not a page any role can be
 * granted independently of what it can already do.
 */
export const TENANT_ASSIGNABLE_PAGES = [
  'dashboard', 'ai-onboarding', 'predictions', 'admin', 'settings',
  // UI-only pages (no dedicated API yet): the frontend shows these to every
  // client user unconditionally today, but they're listed here too so a role
  // can already name them without the save being rejected, once per-role
  // gating for them is wired up on the frontend side.
  'alerts', 'scenarios', 'work-orders', 'cost-administration',
] as const;
// 'alert-agent' used to be here too — removed along with its sidebar entry
// (frontend's Sidebar.tsx); granting it would otherwise look like it does
// something and land nobody anywhere.

export type TenantPage = (typeof TENANT_ASSIGNABLE_PAGES)[number];
