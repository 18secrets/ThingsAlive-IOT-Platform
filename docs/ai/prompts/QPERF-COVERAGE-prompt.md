# QPERF-COVERAGE — the latest reading without reading all of them

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Status: ready.** §7 answered 2026-10-12: the user accepted the recommendation on all three.

**Branch:** `feature/coverage-latest-reading`, off `main`.

Drafted at the user's instruction (2026-10-12), after QONBOARD-STATUS (!90) measured
`SignalBindingService.coverage` as the whole cost of its endpoint.

---

## 0. What was measured

Local Postgres, the demo tenant (`seed:demo`, 6 machines, 370,692 readings, 90 days of
history on EX-01's device), `coverage()` for EX-01, median of five:

| | coverage() |
|---|---|
| right after seeding, tables never analyzed | **299 ms** |
| after `ANALYZE` | **81 ms** |

After `ANALYZE`, 14 queries; one of them is 73 ms of the 86:
`TelemetryWindowReader.latestPerSignalInSegments`. Its plan:

- parallel **sequential scan of all four monthly partitions** (all 370k rows, the whole
  tenant), hash-joined to the 6 segments;
- **77,766 rows sorted** — every reading this machine's device has ever sent for those
  signals — to keep **6**: `DISTINCT ON (signal) ... ORDER BY signal, source_timestamp DESC`.

The cost is proportional to history, not to what is asked. Today's 81 ms is 90 days on
one device; a year of 30–60 s readings is roughly four times that per machine, and the
query runs:

- in `coverage()`: every machine page's `readiness_list` and `schematic`, the site page
  once per machine, onboarding status once per machine;
- in `KpiEvaluatorService` (`latestEverBySignal`): every KPI evaluation, to tell `stale`
  from `no_readings`.

The 299 ms row is a separate problem: a bulk load leaves the planner without statistics
until autovacuum gets round to it, and it picks a worse plan meanwhile (§3).

## 1. The query asks for one row per signal — read one row per segment

Rewrite `latestPerSignalInSegments` so that each segment is answered by an index probe:
for each `(signal, imei, from, to)`, the newest `source_timestamp` with
`from <= ts < to` (or no upper bound) and `ts <= at`, by
`ORDER BY source_timestamp DESC LIMIT 1` — a `LATERAL` join over the unnested segments.
`ix_telemetry_reading_lookup (tenant_id, imei, signal, source_timestamp)` already exists
on every partition and is exactly the order this needs. Then the latest per signal across
its segments (a signal moved between devices has several).

**Same answer, exactly.** Same signature, same `Map<signal, Date>`, same half-open
segment bounds, same `at` cap, same "ever, but within the bindings" meaning the KPI
evaluator's comment describes. Nothing above the reader changes.

**Partition pruning must survive.** Keep `source_timestamp` bounded so the planner can
prune, and prove it as `explainPartitions` already does for the other two queries: add
the same check for this one.

## 2. Coverage's per-requirement loop

`coverage()` also issues one `signal_binding_version` query per requirement (~0.6 ms
each, 6–12 per machine). Load them in one query for the machine and group in memory. Same
filter, same result. Small, but it makes `coverage()` a fixed number of queries per
machine, which is what a batched coverage would build on later.

## 3. Statistics after a bulk load

`seedDemo` and `topUpDemo` run `ANALYZE "telemetry_reading"` after they insert. §7 Q1.

## 4. Tests

`test/telemetry-latest-reading.spec.ts`:

- **The old query is the oracle.** Keep today's query in the spec, verbatim, and assert the
  new method returns the identical map across: one segment; a signal on two devices
  (moved); a closed segment (`to` set) with newer readings after it on the same device,
  which must not count; readings after `at`, which must not count; a segment with no
  readings at all; a signal bound but never reported. Seeded across at least two monthly
  partitions.
- **Work does not grow with history:** run the new query under `EXPLAIN (ANALYZE)` for one
  machine with 10 days and with 90 days of readings, and assert the rows read from
  `telemetry_reading` are the same small number in both (one per segment per partition
  touched) — not the times, which are noise in CI.
- **Pruning:** the partition check from §1.
- `coverage()` for a machine runs a fixed number of queries whatever its number of
  requirements (§2) — counted the way `onboarding-status.spec.ts` counts.

`signal-binding-coverage.spec.ts`, `signal-freshness.spec.ts`, `kpi-evaluation.spec.ts`,
`seed-demo.spec.ts`, `composed-page.spec.ts` and `onboarding-status.spec.ts` pass
unchanged. If any of them needs editing to pass, stop and report — the answer changed.

## 5. Out of scope

- A batched `coverageMany` for the site page and onboarding. Re-measure after this; with
  one probe per segment it may not be worth having.
- A "latest reading" table or materialized view. It would be a second copy of the truth
  for the ingest path to keep current, and §1 may make it unnecessary.
- `readSegments` and `readBucketedSegments`: they return series, and a window's worth of
  rows is what they are for.
- Any index change. If §1's plan does not use `ix_telemetry_reading_lookup`, stop and
  report the plan rather than adding an index.

## 6. Done when

`npm run build` and `npm run test:db` green; `test:db` counts before and after on a
worktree off `origin/main`, naming the base SHA; full suite on the branch. **Report the
§0 table again, after**: the same machine, the same seed, analyzed and not, plus the
`EXPLAIN (ANALYZE, BUFFERS)` of the new query.

## 7. Decisions (answered 2026-10-12 — the recommendation, each time)

1. **ANALYZE in the seeders (§3)?** Recommendation: yes. It costs well under a second on the
   demo's 370k rows and removes a 3.7× slowdown that otherwise lasts until autovacuum runs —
   which is the window in which testers first open the demo. It touches
   `src/database/seeds/seed-demo.ts`, a shared file. The production ingest path is
   continuous rather than bulk, so autovacuum's thresholds are the right tool there and
   nothing changes for it.
2. **§2 in this task or later?** Recommendation: in. It is small, it is in the same method,
   and leaving it means the next person to measure coverage finds the second cost straight
   after the first.
3. **Does Development show the same plan?** Unknown: measured locally only, and Railway's
   Development database has different data volumes and its own autovacuum history. A
   read-only `EXPLAIN` there would confirm before any code is written. That is a query
   against a Railway database, which `CLAUDE.md` allows (read-only), but it needs a
   connection string. Recommendation: run it if one is available; if not, the oracle and
   row-count tests above stand on their own.

## Recorded at implementation (2026-10-12)

The §0 table again, same seed and machine (EX-01), local Postgres, median of five. "Before"
was measured on a worktree off `origin/main` (`d828bc1`).

| | `coverage()` | `machinePage()` |
|---|---|---|
| before, fresh seed (never analyzed) | 297.2 ms | 560.2 ms |
| before, analyzed | 76.1 ms | 166.6 ms |
| after, seeder's ANALYZE removed | 4.3 ms | 205.2 ms |
| **after, as shipped** | **2.9 ms** | **105.0 ms** |

Both halves earn their place. The query is most of `coverage()`'s cost; statistics are most
of the rest of the page's, since its series and bucketed reads also plan badly on an
unanalyzed load: the new query without ANALYZE still loses to the old one with it.

The new query on the demo machine, `EXPLAIN (ANALYZE, BUFFERS)`: a nested loop over the 6
segments, each a `Limit 1` over an `Append` of `Index Only Scan Backward using
…_tenant_id_imei_signal_source_time_idx`, one row each, 24 buffers in all. **Execution
0.099 ms**, against 54.8 ms for the old plan (a parallel sequential scan of all four
partitions, 77,766 rows sorted). Older partitions appear in the plan and contribute no rows:
each probe stops at its first hit.

- §7 Q3 was not answered by measurement. Reading the Railway database's plan was refused
  by the session's permission check (production reads), and was not retried. The oracle,
  rows-read and pruning tests stand on their own, as the decision allowed.
- The per-requirement binding read (§2) loads all rows for the machine's required roles in
  one query and filters by `(measurement_role, component_scope)` in memory, the exact
  filter the loop used.
- Mutation-checked: restoring the old query fails the rows-read test; restoring the old
  loop fails the query-count test. The old query passes the oracle tests, as it must.
