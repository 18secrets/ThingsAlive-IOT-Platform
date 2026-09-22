# Decisions

Settled architecture and the reason. Record once; do not reopen in every conversation.
A decision here is only reversed by a new dated entry that says so.

## D01 — 2.0 never writes to the 1.0 telemetry backend
Read-only through a bounded adapter (`src/legacy`). Users are created in 2.0; the existing
platform keeps the raw data. Any layer that needs to write upstream is wrong about where
its data lives. Matches G05.

## D02 — Row-level security runs under an unprivileged role
`ta_app` owns nothing and cannot `BYPASSRLS`; tenant context is transaction-local; policies
are `FORCE`d. RLS is inert under a superuser even with FORCE, so the role and the
`SET LOCAL` are load-bearing rather than belt-and-braces. Found by a test returning rows it
should not have, not by reading the schema.

## D03 — Capabilities are code, roles are rows
A client can define roles Things Alive has never heard of, so a console that switches on a
role name breaks the first time a customer renames one. `capabilitiesFor(scope)` is the one
answer, used by both the guard and `/me/permissions`; a resolved tenant role wins outright
rather than merging with the static table, or a client could not take a capability away.

## D04 — Granting copies; the copy is the client's
An entitlement copies equipment classes, scenarios, alert templates and causal chains into
the account. Things Alive cannot then write them. Provenance is a content checksum:
`unchangedSinceCopy` compares a fresh checksum against the one stored at copy time,
`newerTemplateAvailable` compares copied version against latest published. Re-granting never
overwrites an existing copy.

This **overrides** shared-contract §2A's "persist versioned references, do not duplicate
authoritative values into an independently editable profile". Both console READMEs endorse
the copy behaviour ("tuned per tenant without touching the underlying Scenario Definition").
Upgrades are surfaced and adopted explicitly, never propagated silently.

## D05 — Published definitions are immutable
`(slug, version)` is unique. A change publishes a new version rather than moving thresholds
under alerts already running on the old one.

## D06 — Mirrors stay upstream-owned; 2.0 owns a table beside them
`equipment_projection` is a read-only mirror and `equipment_profile` holds 2.0's own
attributes next to it. A 2.0 column inside a mirror leaves the next full reconcile unable to
tell upstream drift from a local edit. **Q08S follows this precedent**: `sensor_map_projection`
is not altered, and `signal_binding_version` is a new tenant-owned table beside it.

## D07 — Readiness is per layer; the badge is derived
Storage keeps per-layer availability (shared contract §2A): a machine can be physics-ready,
forecast-blocked and ML-unavailable at once. Display collapses that into the G04 grouping —
Operational, Analytical, Prediction, each row Ready, Pending or Blocked with its reason.
The shipped `availableNow` / `availableLater` / `notApplicable` buckets are retired. Settled
because the delivery kit's G04 and both console READMEs arrived at the same vocabulary
independently.

## D08 — Two model registries, never one control
`llm_provider_config` (answer model) is Master Admin configuration, effective next request.
The embedding profile is pinned and immutable per index generation; changing it invalidates
every stored vector, so it is a reindex migration behind an explicit job and is not reachable
from the provider screen. One combined control is how retrieval gets destroyed silently.

## D09 — Vectors live in the database that holds tenancy
pgvector goes in the existing Postgres, migrated to a pgvector-capable image. No second
database for vectors: one visibility predicate must cover the semantic branch, the lexical
branch and citation downloads, and splitting the store moves retrieval authorization out of
RLS and into application code.

## D10 — MCP is internal for now
The adapter is consumed in-process. Remote transport, token audience validation and
client-token forwarding are deliberately out of v1 and are required before any external
consumer. The adapter never implements a second permission policy.

## D11 — The queue is the PostgreSQL outbox
`domain_event` plus the `shift_run` lease ledger. Redis and RabbitMQ are not present and are
not added by assumption.

## D12 — No streaming evaluation layer; scoring stays on shift boundaries
Readings arrive every 30–60 seconds. At ~170 assets and ~10 signals that is ~57 rows/second,
about 0.2% of what one Postgres does with batched inserts, and the next reading is 30,000 ms
away. There is no latency budget to optimise, so no Rust/Go stream worker, no PG-Strom (GPU
only, and not attachable to managed Postgres), no Materialize, and no alerting from memory.

Compute-in-motion also conflicts with the model on purpose: readings are persisted first and
scored on shift boundaries **so a late reading can revise an outcome**. A stream evaluator
cannot revise — it has already alerted.

Four principles from the proposals do transfer, none of them about speed: bounded
pre-allocated buffers for backpressure (the real burst is a store-and-forward logger dumping
an eight-hour backlog, ~960 readings per signal at once); pipelined stages with bounded
queues; deterministic work per cycle — no unbounded query in the hot path, a timeout on
everything, a cap on rows per batch; and fixed-function over dynamic dispatch, which P04's
allowlisted formula AST already is.

**LISTEN/NOTIFY is rejected as an alert path.** Notifications reach only currently-connected
listeners, so a redeploy loses them with no replay; the payload caps at 8000 bytes; a trigger
fires at COMMIT rather than per statement; and PgBouncer in transaction mode breaks LISTEN
outright. An alert lost during a deploy is worse than a polled one, and `domain_event` is
already durable. It remains available as a *wake signal* for the outbox drainer.

## D13 — The scaling axis is storage, not speed
The same arithmetic gives ~1.8B rows/year for one 170-asset tenant — roughly **450 GB**
with the heap tuple plus the dedupe and lookup indexes. That is where this hurts: vacuum,
query planning, backup windows and Railway storage cost.

So: **partition `telemetry_reading` by month with native PostgreSQL declarative
partitioning.** No extension, no image change, no conflict with pgvector, and retention
becomes `DROP TABLE` on a partition rather than a `DELETE` that leaves bloat behind.

TimescaleDB is revisited later and on evidence. Its compression on time-series is genuinely
good, and that is a storage argument rather than an ingest-speed one. If adopted it must be
the **same image that carries pgvector**, or the database splits and D09 breaks.

Nothing in the ingest path changes now. Batched inserts, the dedupe index, watermarks and
late-arrival reconciliation already handle this volume without noticing.

## Open, and blocking something

- **web/ versus frontend/** — `feature/dev` deletes `web/` entirely. Whichever branch merges
  second decides silently. `feature/dev` has no merge request open. (P1-139)
- **`LEGACY_DB_*` credentials** — nothing is scored without them.
- **Visual Workflow Backend Addendum v1.1** — referenced by P11 and Q18/Q19, present nowhere.
