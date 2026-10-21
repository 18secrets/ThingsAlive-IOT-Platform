# QPART1 — monthly partitioning of `telemetry_reading`

Paste into Claude Code CLI in `C:\dev\things-alive-iot-platform-2.0`.
Read `CLAUDE.md` first; every rule in it applies.

Save the task at `docs/ai/tasks/telemetry-scale-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/telemetry-partitioning`

Pick a migration timestamp above every migration on `main`. As of now the highest is
`1758020000000-DeclaredKindIsOptional`. Check rather than assume — `main` has moved four
times this week.

---

## Why this is first

Two things downstream depend on it, and both fail quietly without it:

- The **replay gate** (D28) runs a candidate alert rule against 90 days of readings for one
  machine. Against an unpartitioned table that is a full scan per candidate.
- The **machine page** (D29) reads a 12-hour series per widget, many widgets per page.

It is also the cost control (D24): storage, not models, is what breaks the budget, and you
cannot drop old data cheaply without partitions.

## The table as it stands

From `1757660000000-InitProjections`:

```sql
CREATE TABLE telemetry_reading (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  imei             text NOT NULL,
  signal           text NOT NULL,
  value            double precision NOT NULL,
  unit             text,
  source_timestamp timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL DEFAULT 'live'
);
CREATE UNIQUE INDEX uq_telemetry_reading_dedupe ON telemetry_reading (imei, signal, source_timestamp);
CREATE INDEX ix_telemetry_reading_lookup ON telemetry_reading (tenant_id, imei, signal, source_timestamp);
```

It also carries the `tenant_isolation` row-level-security policy from
`1757670000000-ScopeAndRls`. **Read that migration before writing anything** — the policy,
the FORCE, and the `ta_app` grants all have to survive this change, and a partitioned table
handles each of them differently.

## 1. Partition scheme

- **RANGE partitioning on `source_timestamp`**, monthly. Not `received_at`: every query and
  the dedupe key use `source_timestamp`, and a late arrival must land in the month it was
  measured, not the month it turned up.
- Partition naming: `telemetry_reading_YYYY_MM`.

**The primary key has to change.** Postgres requires a partitioned table's primary key and
every unique index to include the partition key, so `id` alone cannot be the primary key.
Use `PRIMARY KEY (id, source_timestamp)`.

`uq_telemetry_reading_dedupe` already includes `source_timestamp`, so it survives unchanged
and stays globally enforced. Prove that with a test rather than assuming it — it is the
constraint every baseline in the platform rests on.

## 2. Migrating the existing data — measure before choosing a strategy

**Do this first, before writing anything.** Against the deployed Development database:

```sql
SELECT count(*), min(source_timestamp), max(source_timestamp),
       pg_size_pretty(pg_total_relation_size('telemetry_reading'))
FROM telemetry_reading;
```

Report the numbers. They decide the strategy, and they decide whether this migration can
run inside `preDeployCommand` at all.

TypeORM wraps each migration in a transaction. A copy of a large table holds a lock for its
whole duration, and the deploy waits on it — the container does not start until migrations
finish. A migration that takes four minutes is a four-minute outage on every future deploy
that has to replay it.

### Path A — copy. Use when the table is small (say under a million rows).

1. Rename the existing table out of the way.
2. Create the partitioned table: same columns, adjusted primary key, both indexes on the
   parent (they become local indexes on each partition automatically).
3. Create partitions covering every month present in the old data, plus the current month.
4. `INSERT INTO ... SELECT` the old rows across.
5. **Verify the row count matches** before dropping the old table — inside the same
   migration, and raise if it does not. A silent short copy is unrecoverable.
6. Drop the renamed table.

### Path B — attach. Use when it is large.

No copy at all:

1. Rename `telemetry_reading` to `telemetry_reading_legacy`.
2. Add a `CHECK` constraint on it matching the full range of data it holds — this is what
   lets Postgres attach it without a validating scan.
3. Create the partitioned parent.
4. **`ATTACH PARTITION`** the legacy table for its range.
5. Create forward partitions from the current month onward.

Instant, regardless of size. The cost is that the historical partition is one large
partition rather than monthly ones, which is acceptable — pruning still works at its
boundary, and old data is what QARCH1 archives anyway.

Watch for: the parent's primary key is `(id, source_timestamp)` and the legacy table's is
`(id)`. Attaching requires the partition to satisfy the parent's constraints, so the legacy
table's primary key has to be rebuilt to match **before** the attach. Test that step
specifically — it is where this path fails.

**Say which path you took and why.** If the measurement says Path B, also say whether the
primary key rebuild on the legacy table is itself slow enough to matter.

The down path reverses whichever path was taken: a plain table, the same rows, the original
primary key.

## 3. Creating partitions ahead of need

**No `DEFAULT` partition.** A default partition silently accumulates rows that belong
elsewhere and then blocks attaching the correct partition later — a worse failure that
surfaces months after the cause. An insert with no matching partition should fail loudly.

So partitions must always exist ahead of the data:

- A function `ensure_telemetry_partition(month date)` that creates the partition if absent,
  idempotent, safe to call concurrently.
- The migration creates partitions from the earliest existing row through **12 months
  ahead**. Empty partitions cost nothing.
- A **daily maintenance task in the `scheduler` service** that ensures the next 3 months
  exist. Follow the pattern of the existing shift runner, including its enable flag —
  do not invent a second scheduling mechanism.

## 4. Row-level security — the part that is easy to get wrong

RLS on a partitioned parent applies to queries **through the parent**. A query against a
partition directly is not covered by the parent's policy.

So `ensure_telemetry_partition` must, for every partition it creates:

- `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
- create the same `tenant_isolation` policy the parent carries
- `GRANT` to `ta_app` exactly the privileges the parent grants — no more

And the migration must do the same for every partition it creates directly. If a new
partition is created without these, telemetry silently becomes cross-tenant readable, and
nothing in the application would report it.

## 5. Tests

Each assertion is a test, in a DB-gated spec, added to `test:db` in `package.json`.

**Correctness**

1. A row inserted with a `source_timestamp` in month M lands in `telemetry_reading_M`.
2. The dedupe unique index still refuses a duplicate `(imei, signal, source_timestamp)` —
   including when the two inserts are in different partitions' months.
3. `ensure_telemetry_partition` called twice for the same month is a no-op the second time.
4. An insert for a month with no partition **fails**, and the error is recognisable.

**Isolation — the ones that matter most**

5. As `ta_app` with tenant A's context, a select through the parent returns none of tenant
   B's rows.
6. As `ta_app`, a select **against a partition directly** also returns none of tenant B's
   rows. Write this one deliberately; it is the failure mode of this whole task.
7. A partition created by `ensure_telemetry_partition` after the migration has RLS enabled,
   forced, and the policy attached — assert it by querying the catalog, not by trusting the
   function.

**Pruning**

8. `EXPLAIN` for a query with a bounded `source_timestamp` range names fewer partitions than
   the total. Assert on the plan, not on timing.

**Migration**

9. Row count before and after the up migration is identical, with three months of seeded
   data spanning partition boundaries.
   **Seed before you migrate.** `1758020000000` ran `UPDATE` before `DROP NOT NULL`, passed
   every local suite because the table was always empty, and failed on the first database
   that had a row. A migration test that starts from an empty table proves the SQL parses.
   Every assertion here must run against data that existed beforehand.
10. The down path restores a plain table with the same rows and the original primary key.
    Name the migration explicitly (`undoMigrationNamed`), not `undoLastMigration`.

## 6. Out of scope

- Retention and the Parquet archive — QARCH1. This task makes dropping a month possible;
  it does not drop anything.
- Query changes anywhere in the application. If a repository query has to change for
  pruning to work, say so in the report rather than changing it quietly.
- Anything under `frontend/`.

## 7. Done when

- `npm run build` clean, `npm test` green, `npm run test:db` green. Report the test count
  before and after, measured by stashing back and running — not the summary line.
- The full migration chain runs from an empty database, and again against a database seeded
  with telemetry spanning three months.
- Report back: the commit SHA, test counts, how many partitions the migration created, and
  anything above you could not implement, with the reason.

**Before you open the MR**, state plainly how long the migration takes against a database
seeded to the size the deployed one actually is. If it is more than about thirty seconds,
say so and stop — a migration that blocks `preDeployCommand` needs a different deployment
approach, not a faster query, and that is a decision rather than an implementation detail.

The last deploy proved the safety net works: a failing migration rolled back whole and the
old version kept serving. That is not a reason to rely on it.
