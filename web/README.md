# Things Alive console

The 2.0 front end. One app that renders as two consoles.

## Two consoles, one build

Things Alive authors the product — equipment classes, their scenarios, alert templates
and causal chains — and grants a copy of it to a customer. A customer consumes their
copies. Those are different jobs, so they are different screens, but they are not
different applications: the rail is built from `GET /me/permissions`, so what somebody
sees follows from what the API would actually let them do.

That is why `src/shell/nav.ts` keys every entry to a capability rather than a role
name. Roles are rows a client owns and can add to; a console that switches on
`ceo-manager` breaks the first time a customer renames a role, and grants nothing to the
custom role they add beside it. A screen with no capability mapping is hidden rather
than shown, so a screen nobody has classified goes missing instead of becoming public.

## Running it

```bash
cp .env.example .env     # point VITE_API_BASE_URL at the API, including /api/v1
npm install
npm run dev
```

The origin you serve from must also appear in `CORS_ORIGINS` on the api service, or the
browser refuses the call before the platform ever sees it. A failure there and a dead
host look identical from the client, which is why the sign-in screen says so.

## The session

`src/lib/api.ts` holds the whole of it, and three decisions there are load-bearing:

- The **access token lives in memory** and never in storage. A token in `localStorage`
  is readable by any script that reaches the page and is valid everywhere immediately.
  The refresh token is the one the platform can revoke, so it is the only one persisted.
- **One refresh is in flight at a time.** 2.0 rotates refresh tokens and treats a second
  use of a rotated one as theft, correctly. Without the shared promise, components
  mounting together each send the same token, the losers trip the reuse detector, and
  the session is revoked — which presents to a user as "signing in signs me out".
- A **failed refresh signs out** rather than retrying, because a retry loop against an
  expired session is how a tab quietly hammers an endpoint for an hour.

## What is built

| Screen | Console | State |
| --- | --- | --- |
| Sign in | both | built |
| Accounts | Things Alive | built — list, provision, suspend, reinstate |
| Entitlements | Things Alive | built — grant matrix, grant and revoke |
| Device pool | Things Alive | built — register, assign, release, retire, history |
| Catalog | Things Alive | built — classes, scenarios, alert templates, causal chains, draft and publish |
| Signal aliases | Things Alive | planned |
| Equipment | client | built — sites, machines, move, placement history |
| Devices | client | built — the account's loggers, fit and take off |
| Alerts | client | built — rules marked from template / edited / yours; events stay empty until scoring runs |
| Overview, Activations | client | planned — will render correctly and show nothing until `LEGACY_DB_*` is configured |
| People, Work orders | client | planned |

A planned screen renders as itself and names the route it will read. Nothing is mocked:
a mock that looks finished is how a demo promises something the platform cannot do.

Client screens are hidden from a platform role rather than shown empty. A platform role
holds no row in any customer account and resolves to no tenant, so those screens read
data it has no scope for — and the capability map does grant a few of them, because a
capability is permission to do a thing rather than the existence of data to do it to.
Support looking into one customer's account is its own screen, with the account named
and the access audited.

The `route` field on each nav entry is not decoration. It caught its own first mistake:
Overview was written as `GET /predictions`, and there is no fleet-wide predictions
route — predictions are per machine. Overview is built from the routes that are
fleet-shaped, and the roll-up is tracked as backend work rather than assumed.
