# Things Alive IoT Platform 2.0

Prediction scenarios, catalog, actions and integrations — a new service alongside the
existing platform, with its own database. It issues no credentials of its own: it
verifies the token the existing platform issues and reads the tenant from it.

## Run

```bash
npm install
cp .env.example .env      # fill in AUTH_JWT_SECRET; never commit the result
npm run start:dev         # http://localhost:8080/api/v1/health
npm test                  # 24 without a database; 37 with one
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

**Telemetry dedupes on `(imei, signal, source_timestamp)`, enforced by a unique index
rather than a check-then-insert** — two workers on the same queue would both pass a
check. Duplicates are counted no-ops. A duplicate silently corrupts a rolling
baseline, and a corrupted baseline silently corrupts every z-score built on it.

**Two clocks, both UTC**: `source_timestamp` from the logger, `received_at` from the
platform. They diverge routinely, because loggers drift and reconnect with backlogs.

## Layout

```
src/
  auth/          guard, request scope, @Public and @CurrentScope
  common/        severity vocabulary, pagination contract, error envelope
  config/        boot-time environment validation
  database/      data source, migrations, the stand-in seed producer
  health/        /health (liveness) and /ready (readiness — what the platform probes)
  me/            /me and /me/permissions — capability list the UI guards read
  projection/    read-only mirrors of equipment, devices and sensor mapping + contracts
  telemetry/     readings, deduped at the database
test/
  auth-matrix    enumerates every registered route and asserts it refuses anonymous callers
  severity       mapping is total, and refuses to guess
  error-envelope shape of every failure, including that a 500 leaks nothing
  migration      up, down, and up again — a down path that drops less than it created
  projection     idempotent sync, tenant refusal, reconcile, and replay integrity
```

The auth matrix test enumerates routes from the running router, so a new controller is
covered the moment it is added — nobody has to remember to extend the file.

## Not here yet

No broker subscription and no scoring. `/ready` still reports `not_configured` for
the broker, deliberately: a readiness probe that claims health it cannot verify is
worse than one that admits the gap.
