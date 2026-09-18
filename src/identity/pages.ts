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
  'dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings',
] as const;

export type TenantPage = (typeof TENANT_ASSIGNABLE_PAGES)[number];
