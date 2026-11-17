#!/usr/bin/env node
/**
 * Fails when a page can be opened that no role can be given, or a role can be given a
 * page the other side has never heard of.
 *
 * The geofence map and Administration's Models, Service roster and Fuel forecast tabs
 * each arrived without an entry on the Roles page (found 13 Nov 2026): they rode on
 * "dashboard" and "admin", so an account's owner could not decide who saw them. Nothing
 * failed, because nothing compared the console's routes with what a role can hold. This
 * does, three ways:
 *
 * 1. The frontend's grants (CLIENT_ASSIGNABLE_TABS plus `admin-<tab>` for each of
 *    CLIENT_ADMIN_SUBTABS) and the backend's TENANT_ASSIGNABLE_PAGES are the same set.
 *    A page only one side knows is either refused on save or granted to no effect.
 * 2. Every top-level route in App.tsx is a page a role is granted (a `case` in
 *    pageAccess.ts's clientTabOf), or is listed below with the reason it is not.
 * 3. Every page clientTabOf lets ride on another page's grant is listed below too.
 *
 * Read as text, not compiled: this runs in `npm run lint` beside check-encoding.js,
 * before anything is built. A new page fails here until somebody decides who sees it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Routes that are not a page a role is granted, and why. */
const NOT_A_GRANTED_PAGE = {
  'sign-in': 'before sign-in',
  'forgot-password': 'before sign-in',
  'accept-invitation': 'before sign-in',
  'dashboard-live': 'redirects to /dashboard',
  users: 'redirects to /admin/staff (Things Alive staff)',
  devices: 'a child of /admin (devices/new), under the Devices tab',
  'catalog-import': 'a child of /admin, Things Alive staff only',
  category: 'a child of /admin (category/:slug), Things Alive staff only',
  ':subTab': 'a child of /admin: each client tab is its own grant (CLIENT_ADMIN_SUBTABS)',
  'client-users': 'follows user.manage, not a page list (TC_193)',
  roles: 'follows role.manage, not a page list (TC_193)',
  '*': 'the router fallback',
  // Open to every signed-in person today: clientTabOf has no case for it. Who should see
  // it is not decided yet (13 Nov 2026); listed so the next page cannot slip in the same way.
  drafts: 'the assistant\'s drafts, open to every role (undecided)',
};

/** Pages clientTabOf opens on another page's grant, and why. */
const RIDES_ON = {
  equipment: 'dashboard — a machine\'s page is reached from the dashboard',
  sites: 'dashboard — a site\'s page is reached from the dashboard',
  'alert-agent': 'alerts — the alert agent is part of Alerts',
};

const stringsIn = (source, startPattern) => {
  const match = startPattern.exec(source);
  if (!match) throw new Error(`check-page-grants: cannot find ${startPattern}`);
  const start = match.index + match[0].length;
  const body = source.slice(start, source.indexOf(']', start));
  return [...body.matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)].map((m) => m[1]);
};

const problems = [];

// 1. Both sides grant the same pages.
const backend = new Set(stringsIn(read('src/identity/pages.ts'), /TENANT_ASSIGNABLE_PAGES = \[/));
const types = read('frontend/src/types.ts');
const adminTabs = stringsIn(types, /CLIENT_ADMIN_SUBTABS = \[/);
const frontend = new Set([...stringsIn(types, /CLIENT_ASSIGNABLE_TABS: NavigationTab\[\] = \[/), ...adminTabs.map((t) => `admin-${t}`)]);
for (const page of frontend) if (!backend.has(page)) problems.push(`"${page}" is offered on the Roles page but missing from src/identity/pages.ts — saving it is refused.`);
for (const page of backend) if (!frontend.has(page)) problems.push(`"${page}" is in src/identity/pages.ts but not offered on the Roles page (frontend/src/types.ts).`);

// 2 and 3. Every route is a granted page, or says why not.
const access = read('frontend/src/lib/pageAccess.ts');
const fnStart = access.indexOf('function clientTabOf');
const fnBody = access.slice(fnStart, access.indexOf('\n}\n', fnStart));
const cases = new Set([...fnBody.matchAll(/case '([^']+)'/g)].map((m) => m[1]));
for (const page of cases) {
  if (!frontend.has(page) && !RIDES_ON[page] && !NOT_A_GRANTED_PAGE[page]) {
    problems.push(`/${page} opens on another page's grant (pageAccess.ts clientTabOf). Give it its own grant, or list it in RIDES_ON with why.`);
  }
}
const routes = new Set([...read('frontend/src/App.tsx').matchAll(/<Route\s+path="\/?([^"/]+)/g)].map((m) => m[1]));
for (const first of routes) {
  if (frontend.has(first) || RIDES_ON[first] || NOT_A_GRANTED_PAGE[first]) continue;
  problems.push(
    `/${first} is a page no role can be given. Add it to the Roles page — CLIENT_ASSIGNABLE_TABS (or CLIENT_ADMIN_SUBTABS) `
    + 'in frontend/src/types.ts, TENANT_ASSIGNABLE_PAGES in src/identity/pages.ts, a case in pageAccess.ts, and a migration '
    + `granting it to roles that can open it today — or list it in scripts/check-page-grants.js with the reason it is not.`,
  );
}

if (problems.length) {
  console.error('Page grants: every page needs a decision about who sees it.\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Page grants: ${frontend.size} grantable pages, the same on both sides; every route accounted for.`);
