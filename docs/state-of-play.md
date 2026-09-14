# State of play

Last updated: 12 September 2026, after slice 7 (MR !7).

A short orientation note for anyone — person or agent — picking this repository up
without the context of the session that wrote it. It records where the work stands
and the handful of decisions that are expensive to rediscover. It is not a design
document: the task board and its definitions of done live in the build plan tracker,
and the reasoning behind each slice lives in its merge request description.

## The branch chain

Each slice stacks on the one before it. None are merged yet, deliberately — the
chain is reviewable slice by slice, and merging out of order would lose that.

| MR | Branch | Targets | What it is |
|----|--------|---------|------------|
| !1 | `feature/foundations` | `main` | Versioned API, auth by default, severity, CI |
| !2 | `feature/projections` | `feature/foundations` | Read-only mirrors of the existing platform, telemetry ingest |
| !3 | `feature/tenant-scope` | `feature/projections` | Scoped data layer and row-level security |
| !4 | `feature/catalog` | `feature/tenant-scope` | Catalog, entitlements, recommendation engine |
| !5 | `feature/catalog-content` | `feature/catalog` | DG and CNC content, drafted for domain review |
| !6 | `feature/client-owned-catalog` | `feature/catalog-content` | Template library; granting hands the client a copy they own |
| !7 | `feature/activation` | `feature/client-owned-catalog` | `equipment_scenario`, the transition table, the outbox |

137 tests across 14 suites, green against a real Postgres 16. Lint, build, the secret
scan and the `ta.bypass` escape-hatch guard all clean.

## Four decisions that are expensive to rediscover

**Isolation is two layers, and the second one is not decoration.** The scoped
repository makes an unscoped query a compile error; Postgres row-level security is
the backstop for anything that reaches the database another way. There is exactly one
escape hatch, in `src/scope/tenant-session.ts`, and CI fails the build if `ta.bypass`
appears anywhere else.

**RLS needs an unprivileged role to mean anything.** A superuser bypasses every
policy unconditionally, `FORCE` included, and the managed Postgres hands out a
superuser. So the pool connects with `-c role=ta_app` and every tenant transaction
does `SET LOCAL ROLE`. Remove either and the policies still exist, still look right in
`pg_policies`, and stop doing anything at all. This was found by a test that returned
rows it should not have, not by reading the schema.

**A role is cluster-wide; a migration is per-database.** The `ScopeAndRls` down path
does `DROP OWNED BY "ta_app"` and deliberately does not drop the role — another
database on the same cluster may still be using it. A rollback that drops it fails,
and fails in a way that is confusing to diagnose.

**The client owns their copy.** Granting an equipment class copies it and its
published scenarios into the account. Master admin authors templates and can never
edit a client's settings — not by convention but because no platform role holds the
client-catalog capability and every client-catalog method runs inside the caller's own
tenant session. Each copy records the template slug, version and a content checksum
taken at the moment of copying, so a newer template can be offered without ever being
applied, and "is this still what we shipped" is answerable without the client having
mentioned that they changed it.

**Published catalog definitions are immutable.** `(slug, version)` is unique. A change
publishes a new version rather than moving a threshold under alerts already running on
the old one.

## Waiting on Things Alive

| Task | What it blocks |
|------|----------------|
| `P0-19` | Confirm the unit of `oil_pressure_scaled` — the decoder divides the raw word by 1000 and declares no unit, while the thresholds are OEM defaults in bar. If it yields MPa the scenario never fires, and a fleet with an oil pressure problem looks exactly like a healthy one. Blocks publishing the DG templates. |
| `P0-16` | RabbitMQ hardening. Now blocks delivery of events already being written to the outbox, as well as every scoring task. |
| `P0-15` | Tenant claim in the platform-issued token. |
| `P0-17` | Commit `package-lock.json`; CI runs `npm install` until then, so the build is not reproducible. |
| `P0-18` | Review MR !1–!7. |
| `P1-02` | Domain review of the failure modes and thresholds. |
| `P1-64` | Whether the CNC class ships in phase one. |

## Where the UI comes from

Screens follow the design and navigation of the existing Things Alive analytics work.
2.0 does not invent its own visual language; it reuses that one. Nothing else about
that project feeds into this service.

## Working notes

The build environment is ephemeral and local git history does not survive it. The
GitLab remote is the record — commits reach it through the connector rather than
`git push`. If the working tree looks like a fresh repository with no history, that is
expected; the branches above are all on the server.
