# Things Alive IoT Platform 2.0

Prediction scenarios, catalog, actions and integrations — a new service alongside the
existing platform, with its own database. It issues no credentials of its own: it
verifies the token the existing platform issues and reads the tenant from it.

## Run

```bash
npm install
cp .env.example .env      # fill in AUTH_JWT_SECRET; never commit the result
npm run start:dev         # http://localhost:8080/api/v1/health
npm test                  # 37 without a database; 88 with one
npm run lint              # tsc --noEmit
```

### Database tests

The migration and projection suites need a real Postgres and are **skipped with a
warning** when `DB_HOST` is unset — a green run without it is not a complete one.

```bash
docker run --rm -d -p 5433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust \\
  --name ta2-pg postgres:16-alpine
createdb -h localhost -p 5433 -U postgres ta2_test

DB_HOST=localhost DB_PORT=5433 DB_DATABASE=ta2_test npm test
```

pg-mem and sqlite would run faster and prove less: what these tests check is a unique
index deciding a conflict and a migration's down path, and both are Postgres
behaviour. CI runs them against `postgres:16-alpine`.

### The two database roles

Migrations run as `DB_USERNAME`, which must own the schema. Everything else runs as
`ta_app` — an unprivileged, NOLOGIN role the RLS migration creates, which the
connection pool switches into at startup. Run the migrations before starting the
service on a fresh database, or it will refuse to connect: the role will not exist
yet.

That refusal is the design. A superuser bypasses row-level security unconditionally,
`FORCE` included, and a managed Postgres hands out a superuser by default — so a
service that quietly fell back to its login user would pass every test, look healthy,
and enforce nothing.

### Seeding the projections

```bash
DB_HOST=localhost DB_PORT=5433 DB_DATABASE=ta2_test \\
  npx ts-node src/database/seeds/seed-projection.ts [snapshot.json]
```

The seed pushes a file through exactly the contract and service the real producer
will use, so the eventual integration is a producer swap rather than a rewrite.

Swagger: `/api-docs`. All routes live under `/api/v1`.

## What is deliberate here

**Versioned from the first commit.** `/api/v1` costs nothing now and cannot be added
cheaply once callers exist — the existing platform serves its routes bare and adding a
prefix there would break every client.

**Authenticated by default.** The guard is global. `@Public('reason')` marks *one route*
and takes a reason; it cannot be applied to a controller class. The existing platform has
fifteen class-level `@Public()` decorators, which is how tenant records ended up answering
unauthenticated callers.

**A token with no tenant claim is rejected**, never treated as "all tenants". That failure
mode turns a bug into a cross-customer data leak.

**One severity vocabulary** (`src/common/severity.ts`). Foreign values are mapped at the
boundary and an unknown value throws rather than defaulting — a silently downgraded
severity is a missed alert.

**CORS from configuration with no permissive fallback**, and the service refuses to start
in production without its secrets.

**Errors share one envelope**: `{ error: { code, message, details } }`, with internal
messages logged and never returned.

**The projection is read-only and it drifts.** Every row carries `source_updated_at`,
`synced_at` and a checksum so staleness is visible rather than silent — a prediction
scored against a four-hour-old sensor mapping is wrong in a way that looks like a
model problem. A `full` snapshot also reconciles, marking rows the source no longer
reports; a `delta` never does, because treating a partial sync as the whole population
would mark an entire fleet missing.

**A row with no resolvable tenant is refused, not defaulted.** It lands in
`projection_rejection` where somebody can see it. An untenanted row is a row every
tenant can read.

**Tenant isolation is two layers, and the second is tested by going around the
first.** `ScopedRepository` takes a `RequestScope` as the first argument of every
method and removes `tenantId` from the `where` type, so an unscoped query is a
compile error rather than something a reviewer has to catch. Postgres then applies
the same rule again: every scoped session sets `ta.tenant_id` and drops to `ta_app`
for the length of the transaction, and the policy on each tenant-owned table matches
against that setting. Code that reaches a table without a session reads zero rows —
not everybody's. `test/scope.spec.ts` issues exactly that query to prove it.

**Crossing tenants is possible, deliberate and recorded.** `acrossTenants()` requires
a platform role and a reason, and writes to `platform_access_log` *before* it reads.
If the audit write fails, the read fails — a log that silently stops writing is worse
than no log, because it still reassures. Write auditing alone would miss the access
that matters here: a support engineer opening a customer's data changes nothing and
otherwise leaves no trace.

**One escape hatch, and CI keeps it singular.** `runTenantSpanning()` is the only
thing that sets `ta.bypass`, for the two paths that are legitimately tenant-spanning:
the sync and ingest producers, which write rows for many tenants at once, and the
audited support read. A pipeline job fails if that setting appears anywhere else. An
exemption that can be copied is not an exemption; it is the new default.

**Response fields are filtered on the server, per role** (`@VisibleTo`). Filtering in
the browser is a rendering choice, not a boundary — the response is still one
devtools panel away. There is no implicit exemption for platform roles: if support
should see a field, its role is named like anyone else's.

**The catalog is platform-owned; the entitlement join is what narrows it.** One row
describes a class of machine for every customer that owns one, so there is no tenant
column and row-level security has nothing to match on — `CatalogService` is the single
place a tenant-context read may happen, and every method takes a scope for the same
reason `ScopedRepository` does. Copying the catalog per tenant would mean an OEM
threshold correction had to be applied in fifty places, and the fiftieth would be
missed.

**An unentitled class is a 404, never a 403.** A 403 confirms the class exists, which
is commercial information: it tells a customer what Things Alive sells, and by
enumeration, roughly to whom.

**Published catalog definitions are immutable.** A change publishes a new version and
activations pin the version they ran against. Editing a live definition would move the
thresholds under every alert already running on it — the incident looks like a model
regression, and the evidence of what changed is gone, because it was overwritten.

**2.0 does not write into the projection.** The class binding, tier and readiness live
in `equipment_profile`, keyed on the same external identity. A 2.0 column inside the
mirror would leave the next full reconcile unable to tell upstream drift from a local
edit, so it would either clobber the tenant's data or refuse to repair real drift.

**Recommendations come from recorded metadata, never inference**, and a blocker is a
reason code with specifics rather than a sentence: `{ code: 'missing-signals',
signals: ['coolant_temp'] }` tells an operator which sensor to fit, where "not enough
data" tells them nothing. An estimated ready date is offered only when time alone will
clear the blockage — a date printed next to a missing sensor is a promise nobody is
keeping.

**Telemetry dedupes on `(imei, signal, source_timestamp)`, enforced by a unique index
rather than a check-then-insert** — two workers on the same queue would both pass a
check. Duplicates are counted no-ops. A duplicate silently corrupts a rolling
baseline, and a corrupted baseline silently corrupts every z-score built on it.

**Two clocks, both UTC**: `source_timestamp` from the logger, `received_at` from the
platform. They diverge routinely, because loggers drift and reconnect with backlogs.

## Layout

```
src/
  audit/         platform access log — who from Things Alive read which tenant's data
  catalog/       equipment classes, scenarios, signal aliases, entitlements, recommendations
  auth/          guard, request scope, @Public and @CurrentScope
  common/        severity vocabulary, pagination contract, error envelope, @VisibleTo
  config/        boot-time environment validation
  database/      data source, migrations, the stand-in seed producer
  equipment/     equipment_profile — what 2.0 knows that the mirror must not hold
  health/        /health (liveness) and /ready (readiness — what the platform probes)
  me/            /me and /me/permissions — capability list the UI guards read
  projection/    read-only mirrors of equipment, devices and sensor mapping + contracts
  scope/         ScopedRepository, the tenant session, the one tenant-spanning hatch
  telemetry/     readings, deduped at the database
test/
  auth-matrix    enumerates every registered route and asserts it refuses anonymous callers
  severity       mapping is total, and refuses to guess
  error-envelope shape of every failure, including that a 500 leaks nothing
  migration      up, down, and up again — a down path that drops less than it created
  projection     idempotent sync, tenant refusal, reconcile, and replay integrity
  scope          both isolation layers, including a query that deliberately skips the first
  field-policy   what each role's raw JSON does and does not contain
  capabilities   the guard and /me/permissions cannot disagree, for every role
  catalog        the entitlement join, version selection, alias resolution
  recommendation every bucket and every blocker code, on seeded assets
  rls-coverage   derived from entity metadata: no tenant-owned table without a policy
```

The auth matrix test enumerates routes from the running router, so a new controller is
covered the moment it is added — nobody has to remember to extend the file.

## Not here yet

No broker subscription and no scoring. `/ready` still reports `not_configured` for
the broker, deliberately: a readiness probe that claims health it cannot verify is
worse than one that admits the gap.
