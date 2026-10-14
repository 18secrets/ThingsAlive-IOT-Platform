**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QML1 — TTM forecasting, residual anomaly, and the producer for `forecast_chart`

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

Also read `docs/ai/decisions/ai-layer-decisions.md` **D18, D20, D26, D35, D40 and D41**.
They are the specification. This prompt only arranges them. Read QML1-SIZE's report
(`docs/ai/measurements/QML1-SIZE.md`) before touching the `Dockerfile`.

**Branch:** `git checkout main && git pull && git checkout -b feature/qml1-forecast`

**Depends on:** QPART1 (complete), Q08S signal bindings (complete), the forecast
declarations on `equipment_class_sensor_requirement` (complete, `1758100000000-LibraryContent`),
the `forecast_chart` widget slot (complete, QREC0b.1, `1760000000000-ParameterAndForecastWidgets`).
**QML1-SIZE must have reported before this ships** (D35, D40 §2). It may be written before
then. It may not be merged before then.

**Do not start until every question at the end is answered.** Several of them decide
schema.

---

## 0. Why

Layer 2 of D18 does not exist yet. The library already declares which signals are worth
forecasting (`forecast_enabled`, `forecast_horizon_hours`). The machine page already has
a `forecast_chart` slot. That slot answers `not_available` / `no_forecast_model` for every
declared signal, because nothing produces a forecast. QML1 is that producer.

It also produces the anomaly. D20: there is no separate anomaly model. TTM forecasts, the
actual arrives, and a residual outside a learned band is the anomaly. The explanation
("expected 62 °C, saw 81 °C") falls out of the method. QREC1's *Detect* step consumes it.

Two measured facts shape the design:

- **Inference is nearly free**: 1000 series in 0.266 s, 568 MB peak, PyTorch fp32 CPU, on an
  8-core / 8 GB Railway container (D35). So do not ration forecasts (D35, correction 2).
- **The data around inference is not free** (D40). Reading the input and storing the output
  are the costs. Every storage rule below exists because of that.

## 1. Where things live: the process boundary

**There is no Python in this repository today.** `docs/ai/REPO_MAP.md` says so, and the
`things-alive-logic` modules the old kit referenced are not present. TTM is PyTorch, so
QML1 introduces the first Python code. It enters through one narrow door.

```
scheduler container
 ├─ node dist/main.js               (existing: shift runner, partition maintenance, …)
 │    └─ ForecastScheduler          new; a timer, off by default, like ShiftScheduler
 │         └─ spawns ─▶ node dist/forecast-main.js        (D41's entry point)
 │                         ├─ own advisory lock, own ledger, DB only
 │                         └─ spawns ─▶ python3 -I python/forecast/infer.py
 │                                        stdin: forecast-request.v1 (JSON)
 │                                        stdout: forecast-response.v1 (JSON)
 │                                        no DB, no network, no tenant ids
 └─ (on a D41 trigger) the same image as its own Railway service, with start command
    `node dist/forecast-main.js --loop`, and FORECAST_ENABLED=false on the scheduler
```

The rules this diagram encodes, each with its reason:

- **`src/forecast-main.ts` → `dist/forecast-main.js` is the process D41 names.** It boots a
  Nest *application context* (no HTTP) holding only the forecast module and the database.
  It shares no in-process state with `main.js`. It talks to everything else only through the
  database. That is what makes the D41 split a config change and not a rewrite.
- **Node owns everything that touches the database.** Tenant sessions, RLS, binding
  resolution, freshness, the lock and the ledger already exist in TypeScript, and they are
  tested. A Python process with database credentials would need a second implementation of
  tenant isolation. D09's argument against splitting the vector store applies here as well:
  one isolation policy, one place.
- **Python is a pure function**, from series in to forecasts out. It receives opaque series
  ids, never a tenant id, IMEI or machine name. It runs with `HF_HUB_OFFLINE=1`, reads only
  the weights baked into the image, and exits when stdin closes. A crash or a non-zero exit
  fails that pass, records it in the ledger, and touches nothing else.
- **One Python process per pass, started when the pass starts, gone when it ends.** D40 §2
  asks for "loaded when the pass starts and released when it ends". A child process that
  exits returns its memory to the OS. A model unloaded inside a long-lived process may not.
- **Node spawns it with `child_process`.** No npm dependency is added. Python dependencies
  are pinned with hashes in `python/forecast/requirements.txt`, from the versions QML1-SIZE
  measured. No package beyond the ones QML1-SIZE named is added without asking.

### The data contract

The shared contract already says how languages meet: "Use JSON Schema/OpenAPI contracts
between languages" (`docs/ai/layers/01-SHARED-CONTRACT.md`). Two JSON Schemas beside the
existing ones:
`docs/ai/contracts/forecast-request.v1.schema.json` and `forecast-response.v1.schema.json`.

```ts
// request, written once to stdin
{
  contract: 'forecast-request.v1',
  model: { key: string, revision: string },   // must match what the worker loaded, or it refuses
  contextLength: number,                       // from the registry row, not a literal
  predictionLength: number,                    // likewise
  series: Array<{
    id: string,                                // opaque; Node maps it back
    stepSeconds: number,
    start: string,                             // ISO, first context step
    values: number[],                          // exactly contextLength, no nulls (see Question 6)
  }>
}

// response, read from stdout
{
  contract: 'forecast-response.v1',
  model: { key, revision },                    // echoed; Node refuses a mismatch
  series: Array<{ id: string, values: number[] }>,      // exactly predictionLength each
  refused: Array<{ id: string, reason: string }>,       // a series the worker would not forecast
  timing: { loadSeconds: number, inferSeconds: number }
}
```

The worker never returns a `NaN` or `Infinity`. A series that would produce one goes in
`refused`. Node validates the response against the schema before writing anything. A
response that fails validation fails the pass and writes nothing. It is never written in
part.

## 2. The model registry

`forecast_model` is platform-owned and has no tenant column. Each row is one exact, immutable
model version (G13): `id`, `key` (`granite-timeseries-ttm-r2`), `revision` (the pinned
Hugging Face revision hash), `runtime` (`pytorch-cpu`), `context_length`, `prediction_length`,
`weights_sha256`, `status` (`active` | `retired`), `created_at`.

- **At most one `active` row.** Enforce it with a partial unique index, not a service check.
  A service check loses to a concurrent write.
- **No column of a row may change except `status`, and only `active → retired`.** Enforce it
  with a trigger. A forecast references the model that made it. If that row could change,
  every past forecast's provenance would change with it.
- At pass start, `forecast-main` compares the active row's `revision` and `weights_sha256`
  with what the worker reports it loaded. If they differ, the pass refuses to run and says
  so. An image built with different weights from the ones the registry claims would produce
  forecasts carrying false provenance.
- **This is a third registry, separate from the other two.** D08 keeps `llm_provider_config`
  and the embedding profile apart. This one stays apart from both, for the same reason.
- The migration seeds the one row QML1-SIZE pinned.

## 3. What is forecast, and when

**The library decides** (D40 §3). A `(machine, signal)` is forecast only when the machine's
class version declares `forecast_enabled = true` for that signal. `PageService` already
reads that declaration (`forecastDeclarations`). **Extract it so the pass and the widget call
one function.** Two definitions of "declared" would be the `device_projection` versus
`device_inventory` defect again.

**Cadence: four-hourly by default** (D40 §4). The pass timer ticks often. A `(machine, signal)`
is owed when one of these holds:
- its latest forecast is older than the cadence, **and** there are new readings since
  (D40, *incremental*), or
- an alert has been raised on that signal since its latest forecast (D40 §4, *immediate
  re-forecast*). The pass finds these by reading `alert_event`, so the alert path is not
  changed. "Immediate" here means "on the next tick".

**Skip, and say so.** Do not forecast a signal that is `stale` or `no_readings` by the Q08S
s3 freshness rule. A forecast from a dead sensor is a confident fiction (D40). Do not
forecast a signal whose input fails the coverage rule in Question 6. Every skip is
recorded with its reason.

**Bounded, by priority, with a visible skip list** (D40). Each pass has a time budget
(Question 4). Order the work: signals with an open alert first, then signals with enabled
recommendations if `main` has such a flag (if it does not, say so and skip this tier), then
the oldest forecast first. Whatever the budget does not reach goes into the skip list as
`budget_exhausted`. A pass that covers 60% of the fleet and says so is acceptable. A pass
that covers 60% silently is not.

**Cross-tenant enumeration** follows the shift runner exactly.
`src/shift/services/shift.service.ts` lists what is owed with `runTenantSpanning` and a reason
string. Per-tenant reads and writes go through `withTenantId`. CI's escape-hatch job
allows `ta.bypass` only inside `tenant-session.ts`, so this cannot be done any other way. Do not try.

## 4. Input: the step and the read volume

**Resolve readings through the machine's binding segments with `TelemetryWindowReader`.**
Do not write a second telemetry query.

D40's arithmetic, "512 points per series, 1.28 M rows per pass at 500 machines", holds only
if one context point is one raw reading. Readings arrive every 30–60 s (D12), so 512 raw
points cover 4–8 hours. 24 steps ahead would then reach 12–24 minutes into the future. That
cannot serve the `forecast_horizon_hours: 24` the template's own example declares. A 24-hour
horizon needs coarser steps (hourly, say). Hourly steps over 512 points need about 21 days
of context, and reading that raw each pass is roughly 100× D40's estimate.

So the step size, and whether bucketed input is kept between passes, are decisions that
change D40's arithmetic. **They are Question 5. Do not choose them yourself.** The
recommendation there restores D40's numbers.

## 5. Output: latest forecast only, plus residuals, plus one daily sample

D40 §5: storing every horizon point of every pass would make forecast output larger than
telemetry input.

| Table | Grain | Written |
|---|---|---|
| `forecast_latest` | one row per `(tenant, source_system, external_id, signal)` | upserted each pass |
| `forecast_residual` | one row per `(…, signal, step_at)` | when a forecast step's time has passed and its actual is known |
| `forecast_daily_sample` | one row per `(…, signal, day)` | once per day, kept for QEVAL1's backtest |
| `forecast_run` | one row per pass | the ledger |

**`forecast_latest`** carries `model_id` (FK to `forecast_model`), `run_id` (FK to
`forecast_run`), `generated_at`, `step_seconds`, `context_from`, `context_to`, the input
coverage, and `horizon` as `jsonb`: `[{ t, v, lo, hi }]`. The unique key is in the database.
D26: every future number on screen traces to a model run with an id, a horizon and an
interval. This row is that trace. **The interval is not produced by TTM. TTM gives point
forecasts.** Where `lo`/`hi` come from is Question 7.

**`forecast_residual`.** The pass computes residuals **before** replacing the latest row: for
each step of the previous forecast whose time has passed, residual = actual − predicted at
that step. The actual comes from the same bucketing as the input. Residuals made this way
are short-lead residuals (the first cadence-worth of steps of each forecast). Record the
lead time on each row, so QEVAL1 can tell lead times apart. D40 says "the residual attached
to each actual reading". Doing it per raw reading would add rows at telemetry volume. Doing
it per forecast step is the natural grain. **This is a deliberate reading of D40, so confirm it:
Question 8.**

**`forecast_daily_sample`** keeps one full forecast per `(machine, signal)` per day, the first
pass after 00:00 UTC, so QEVAL1 has long-lead forecasts to score. Retention matches the
D14 hot window (90 days) unless Question 9 says otherwise.

**`forecast_run`** records `started_at`, `finished_at`, `budget_seconds`, the counts
considered / forecast / skipped / refused, `skipped` as `jsonb` (`[{ machine, signal, reason }]`),
`model_id`, `python_load_seconds`, `python_infer_seconds`, `outcome`
(`completed` | `budget_exhausted` | `failed` | `lock_held`), and `error`. D41's triggers 1 and 3
are read from this table. The report includes the two SQL queries that evaluate them.

All four tenant-owned tables get `tenant_isolation`. `test/rls-coverage.spec.ts` fails the
suite until they do.

## 6. The anomaly: three states, not two (D20)

For the newest step that has an actual, each forecast signal is in one of three states:

| State | When |
|---|---|
| `baseline_not_established` | fewer than **14 days** of clean residuals for this `(machine, signal, model)` (D20) |
| `normal` | residual inside the band |
| `anomalous` | residual outside the band |

- **`baseline_not_established` is never shown as `normal`** (D20). It is its own value in
  every response, and it is the expected state for every machine for its first 14 days.
- **The band excludes dirty windows** (D20). Residuals from any period with a raised alert
  or an open work order on that signal are left out. Use `alertExcludedRanges` and
  `openWorkOrderExcludedRanges` from `src/catalog/formula/baseline-operators.ts`. Do not write
  a second pair. A band that cannot find 14 clean days stays `baseline_not_established`. It
  never learns from a dirty window.
- **The band records the window it was learned from.**
- **The band is per model.** Residuals against one model say nothing about another model's
  errors. Retiring the active model restarts the 14 days. See Question 10.
- **How wide the band is** (σ multiple, quantile, or something else) is not decided anywhere.
  **Question 11. Do not pick a number.**
- **Whether the band learns only from operating periods**, as QFIX-BASELINE made the KPI
  baseline do, is Question 12.

QML1 **does not raise alerts** from anomalies. It exposes the state. QREC1's *Detect* step
decides what to do with it (D21).

## 7. The `forecast_chart` producer

`PageService` today returns, for a declared signal, `not_available` / `no_forecast_model`. QML1
replaces that with a read of `forecast_latest`:

| Condition | readiness | reason | data |
|---|---|---|---|
| signal not declared | `not_configured` | `forecast_not_declared` | null (unchanged) |
| declared, no forecast row yet | `not_available` | **`no_forecast_model`** (unchanged) | null |
| declared, row exists, input signal stale | `blocked` | `stale` | null |
| declared, row older than the stale rule in Question 13 | `blocked` | `stale` | null |
| declared, fresh row | `ready` | — | the shape below |

```ts
{
  signal, unit, stepSeconds, generatedAt,
  model: { key, revision }, runId,
  horizon: Array<{ t: string, v: number, lo: number | null, hi: number | null }>,
  anomaly: { state: 'normal' | 'anomalous' | 'baseline_not_established',
             at: string | null, actual: number | null, predicted: number | null,
             residual: number | null, band: { lo: number, hi: number } | null }
}
```

**Two existing assertions pin this, and neither may be edited** (`CLAUDE.md`):
`test/parameter-forecast-widgets.spec.ts` expects `no_forecast_model` for a declared signal
with no forecast, and expects `WIDGET_PRODUCERS.forecast_chart` to match `/QML1/`. Keep the
reason string unchanged. Keep "QML1" in the producer description (for example
`'ForecastReader.latest (QML1)'`). If your design cannot satisfy either, **stop and report**.

The page composes. It does not compute (QPAGE1). The widget reads `forecast_latest` and
`forecast_residual`. It never invokes the model.

## 8. Wiring and switches

- `ForecastScheduler` in the scheduler process is modelled on `ShiftScheduler`: a
  `setInterval`, **off unless `FORECAST_ENABLED=true`**, with tick from `FORECAST_TICK_SECONDS`,
  and an in-process `running` guard. Each tick spawns `node dist/forecast-main.js --once`
  and waits for it.
- `forecast-main --once` runs one pass. `--loop` runs its own timer, for the day it becomes its
  own service. Both take the lock.
- **Lock:** a new key beside `SHIFT_PASS_LOCK_KEY`, taken with the existing `tryTakePassLock`.
  Never wait. A pass that finds the lock held records `lock_held` and exits.
- **Setting `FORECAST_ENABLED` on the Railway scheduler service is not part of this task.**
  That is a variable change on an existing service, so it is Deepak's (`CLAUDE.md`).
- The `Dockerfile` change follows whichever variant QML1-SIZE's report and Deepak chose
  (Question 2). The `torch` layer goes **before** `COPY src`, so a source change does not
  rebuild it.

## 9. Files

Create:
- `src/forecast/`: the module, entities, `ForecastService` (the pass), `ForecastReader`
  (what the widget reads), `ForecastScheduler`, the band, the worker client
- `src/forecast-main.ts`
- `src/database/migrations/<ts>-Forecasting.ts`: the timestamp is assigned immediately
  before the MR, after the last merge-in
- `python/forecast/infer.py`, `python/forecast/requirements.txt`
- `test/forecast/stub-worker.js`: a deterministic stand-in speaking the same contract
- `test/forecasting.spec.ts`
- the two contract schemas under `docs/ai/contracts/`

Change, and say why in the MR:
- `src/page/page.service.ts`, `src/page/page-widgets.ts`: the producer
- the module that registers schedulers, to add `ForecastScheduler`
- `Dockerfile`: per Question 2
- `package.json`: append `test/forecasting.spec.ts` to `test:db`. No dependency change.

Do not name the module `prediction`. `src/prediction` is the shift-scoring runtime and
already owns `prediction` and `prediction_baseline`.

## 10. Out of scope

- Raising alerts or work from anomalies. That is QREC1.
- The language model in any role. D26: no numeric value about the future comes from a
  language model.
- A per-class cadence column, unless Question 3 asks for one.
- Splitting the service. QML1 builds it so the split is a config change. The split happens
  on a D41 trigger, by Deepak.
- Backtesting and accuracy. That is QEVAL1, which reads `forecast_daily_sample`.
- Forecasting tenant-added signals (D39), unless Question 14 says otherwise.
- Any Railway change, including `FORECAST_ENABLED`.
- Anything under `frontend/`. Report the widget's response shape for the UI team.

## 11. Tests

All in `test/forecasting.spec.ts`, against the **stub worker**, so `test:db` needs no `torch`.
One further test runs the real model. It is skipped unless `FORECAST_REAL_MODEL=1`, and
it is not in `test:db` (Question 15).

**Refusals, attempted:**
1. Insert a second `active` `forecast_model` row → the database refuses it.
2. `UPDATE forecast_model SET revision = …` → the trigger refuses it.
3. Insert two `forecast_latest` rows for one `(tenant, machine, signal)` → refused.
4. A `forecast_latest` row naming a model id that does not exist → refused (FK).
5. Tenant B reads tenant A's `forecast_latest`, `forecast_residual` and `forecast_run` under its
   own session → zero rows.
6. The stub returns a mismatched model revision → the pass writes nothing, and the run is
   `failed` with that reason.
7. The stub returns a malformed response, a `NaN` or a short series → nothing written, run
   `failed`. Assert the previous `forecast_latest` row is unchanged.
8. The stub exits non-zero halfway → same as 7.

**Behaviour:**
9. A signal not declared `forecast_enabled` is never sent to the worker. Assert on what the
   stub received.
10. A stale signal is skipped, with reason `stale`, in `forecast_run.skipped`.
11. A forecast younger than the cadence with no new readings → not re-forecast.
12. An alert raised on a signal → re-forecast on the next pass despite the cadence.
13. Budget exhausted → priority order respected (alerted signals first), the remainder in
    `skipped` as `budget_exhausted`, and run outcome `budget_exhausted`.
14. Residuals are written for elapsed steps of the previous forecast **before** it is replaced.
    Assert the residual's `predicted` equals the old row's value at that step.
15. 13 days of clean residuals → `baseline_not_established`, never `normal`. Write this one
    deliberately.
16. 20 days of residuals with an alert spanning 7 of them → `baseline_not_established`, because
    the clean span is under 14. The excluded residuals exist and were excluded.
17. An established band and a residual outside it → `anomalous`, with actual, predicted and
    band in the response.
18. The widget: declared with no row → `no_forecast_model`. Fresh row → `ready` with the
    horizon. Stale input → `stale`. The same machine through `machinePage` and through
    `ForecastReader` gives the same answer.
19. `forecast_daily_sample` gets exactly one row per `(machine, signal)` per UTC day across
    several passes.

**Concurrency (the pass is idempotent):**
20. Two passes fired together (`Promise.allSettled`) → both settle without error. One runs
    and one records `lock_held`. Exactly one `forecast_latest` row per key. Residuals are not
    duplicated.
21. The lock taken directly through `tryTakePassLock` with the new key while a pass starts
    → the pass records `lock_held` and writes nothing.

**Migration:**
22. Down path, naming its own migration: `undoMigrationNamed(owner, 'Forecasting<ts>')`.
    The four tables and `forecast_model` are gone. `equipment_class_sensor_requirement` and
    the widget tables are untouched. Seed a row in each new table first. Up then runs clean
    again.

**Seed before you migrate.**

## 12. Done when

- `npm run build && npm run test:db` pass. Before and after counts on a worktree off
  `origin/main`, naming the base SHA. The delta equals the new spec's test count.
- `npm run lint` and `npm run verify:migrations` clean. The chain runs from empty.
- The real-model test passes once locally with `FORECAST_REAL_MODEL=1`. Quote its timing
  against D35's 0.266 s per 1000 series.
- Report: files created, files changed and why, test counts with base SHA, the two D41
  trigger queries, image size against QML1-SIZE's measured variant, every question's answer
  as implemented, and every assumption made.
- Commit and push. Open the MR. Do not merge. Do not set `FORECAST_ENABLED` anywhere.

**One line for the task doc:** TTM is a quarter-second of arithmetic wrapped in a Python
process that sees only numbers. Everything that makes it trustworthy is around it: the
library deciding what to forecast, one lock, one latest row, and a third anomaly state that
never says "normal" before it can know.

---

## Questions — answer before starting

1. **Is the process boundary in §1 right?** Node owns the database, Python is a pure
   stdin/stdout function, and there is one child per pass. D41 names `dist/forecast-main.js`, a
   Node entry point, but does not say how Python is reached. *Recommendation:* as written.
   The alternative, a Python process with its own DB connection, needs tenant isolation in a
   second language.
2. **Which image variant from QML1-SIZE?** `torch` in the shared image, or a scheduler-only
   build target, and Alpine or glibc. *Recommendation:* decide from the QML1-SIZE report.
   The scheduler-only target keeps the api image unchanged.
3. **Cadence: one platform default, or declared per class?** D40 §4 says "cadence is
   declared", but no column exists. Only `forecast_enabled` and `forecast_horizon_hours` do.
   *Recommendation:* a platform constant of four hours in phase 1, with no template change.
   Add a column when a class needs a different cadence.
4. **The pass time budget.** D40 requires one and does not set it. *Recommendation:* 25% of the
   cadence, so hitting the budget and tripping D41's first trigger are the same event and
   cannot disagree.
5. **The step size and the input rollup** (§4). *Recommendation:* hourly steps, and an
   incrementally maintained hourly rollup table (`forecast_input_bucket`), so each pass reads
   only the raw rows since its last bucket, about 240–480 per series per four hours. That
   brings the read volume back to D40's ~1.28 M rows per pass at 500 machines. It also serves
   residual actuals and QEVAL1. The alternative re-reads 21 days raw on every pass.
6. **Gaps in the context window.** TTM needs a complete context. The platform has a rule against
   fabricating data (G07), and a KPI coverage minimum already exists (`MIN_COVERAGE_RATIO = 0.5`
   in `kpi-evaluator.service.ts`). *Recommendation:* refuse below that same ratio. Interpolate
   only interior gaps, and store the count of imputed steps on the forecast row so it shows.
   This is a product call about how much invented input is tolerable, so it is Deepak's.
7. **Where the interval `lo`/`hi` comes from.** D26 requires an interval on every future number.
   TTM gives point forecasts. *Recommendation:* empirical quantiles of the same
   `(machine, signal, model)`'s residuals at the same lead time. That means **no interval, and
   therefore no forecast shown, during `baseline_not_established`**, which D26 read strictly
   requires ("or it does not appear"). Confirm that a machine shows no forecast chart for its
   first 14 days, or say what it shows instead.
8. **Residual grain: per forecast step, or per raw reading?** D40 §5 says "attached to each
   actual reading". *Recommendation:* per step (§5). Per reading adds rows at telemetry volume
   for every forecast signal, and those are the rows D24 identifies as the budget problem.
9. **Retention** of `forecast_residual`, `forecast_daily_sample` and the rollup.
   *Recommendation:* 90 days, matching D14's hot window. QEVAL1 will need the daily sample
   for at least that long.
10. **Retiring a model.** *Recommendation:* the band is keyed by model, so a new model restarts
    the 14-day clock and every machine reads `baseline_not_established` for two weeks. That is
    honest, but visible. Confirm it is acceptable, or decide that bands carry over.
11. **Band width.** Not decided anywhere. *Recommendation:* do not take a number from this
    prompt. Ask for one from domain review, or ship the band as an empirical quantile pair whose
    level is a single named constant set by Deepak.
12. **Does the band learn only from operating periods**, as the KPI baseline does after
    QFIX-BASELINE? *Recommendation:* yes, through the same `OperatingGate`. A parked machine's
    residuals are a second population, and that is the defect QFIX-BASELINE fixed.
13. **When a forecast row counts as `stale`.** *Recommendation:* when it is older than the cadence
    plus one tick, which means the pass has missed it at least once. Otherwise state the rule.
14. **Tenant-added signals** (D39). The forecast declaration lives on the platform class only,
    so a signal a tenant added cannot be declared. *Recommendation:* out of scope for QML1.
    Record it as a follow-up.
15. **Does CI run the real-model test?** It needs `torch` in CI. *Recommendation:* not yet.
    Run it locally in the report, and add a CI job once the image variant is chosen.
16. **Is TTM's licence cleared for commercial use** at the pinned revision? *Recommendation:*
    check the model card at that revision and record it in the registry migration's comment.
    This prompt does not assert it.
17. **Who makes a model `active`?** `docs/ai/layers/01-SHARED-CONTRACT.md` says "predictive ML
    without an approved model is not_available", and G10 says replay can never approve a model.
    *Recommendation:* the migration seeds the row as `active` for phase 1, and that seeding is
    Deepak's recorded approval. Any later activation is a platform-staff action with an audit
    row, taken after QEVAL1 has reported on the candidate. Confirm, or name the approver.
