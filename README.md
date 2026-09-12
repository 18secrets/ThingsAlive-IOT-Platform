# Things Alive IoT Platform 2.0

Prediction scenarios, catalog, actions and integrations — a new service alongside the
existing platform, with its own database. It issues no credentials of its own: it
verifies the token the existing platform issues and reads the tenant from it.

## Run

```bash
npm install
cp .env.example .env      # fill in AUTH_JWT_SECRET; never commit the result
npm run start:dev         # http://localhost:8080/api/v1/health
npm test                  # 24 tests
npm run lint              # tsc --noEmit
```

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

## Layout

```
src/
  auth/          guard, request scope, @Public and @CurrentScope
  common/        severity vocabulary, pagination contract, error envelope
  config/        boot-time environment validation
  health/        /health (liveness) and /ready (readiness — what the platform probes)
  me/            /me and /me/permissions — capability list the UI guards read
test/
  auth-matrix    enumerates every registered route and asserts it refuses anonymous callers
  severity       mapping is total, and refuses to guess
  error-envelope shape of every failure, including that a 500 leaks nothing
```

The auth matrix test enumerates routes from the running router, so a new controller is
covered the moment it is added — nobody has to remember to extend the file.

## Not here yet

No database, broker or scoring — those arrive with the projection and runtime tasks.
`/ready` reports `not_configured` for each until then, deliberately: a readiness probe
that claims health it cannot verify is worse than one that admits the gap.
