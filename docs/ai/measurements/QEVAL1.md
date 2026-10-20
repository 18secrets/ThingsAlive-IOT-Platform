# QEVAL1 — first run report (part 1a, the TTM backtest)

Run 20 October 2026 from branch `feature/qeval1a-backtest`, base `origin/main` `6135d46`.
QEVAL1 is split three ways (question 1): **1a** (this) is the run namespace and the TTM
backtest; **1b** (retrieval) waits on QEMB1; **1c** (recommendation replay) waits on QREC2.

## Verdict

**No model-quality number exists yet, anywhere.** The backtest is built and tested against
hand-worked fixtures, but there is nothing real to run it on:

| | |
|---|---|
| Development | QML1 shipped switched off (MR !130: `FORECAST_ENABLED` unset, and the scheduler not yet pointed at `Dockerfile.scheduler`), so no forecast pass has run there to fill `forecast_daily_sample`, `forecast_residual` or `forecast_input_bucket`. Inferred from that, not queried. |
| Real telemetry | `LEGACY_DB_*` is still blocked (question 5). |
| This machine | `torch` 2.11.0 is installed, `granite-tsfm` and the TTM weights are not. Installing them is a dependency change this task does not have. |

## The one run that could be made: a smoke test on seeded data

A fresh local database (`ta2_eval_smoke`, all 86 migrations), `seed:demo`, then:

```
npm run eval -- --kind ttm_backtest --dataset seeded --replay-days 7 \
  --note "local seed:demo, 20 Oct 2026" --out qeval1-smoke.json
```

| | |
|---|---|
| status | `completed`, exit 0 |
| dataset | `seeded` (labelled smoke test: *"seeded telemetry measures the seeder, not the model"*) |
| versions | scorer `qeval1a-1`; model `granite-timeseries-ttm-r2` @ `d6a79570…`, weights `a706726a…`, context 512, prediction 96 |
| series enumerated | **0** |
| daily-sample backtest | `n: 0`, every MAE `null`, reason `no_scorable_steps` |
| replay | not run, reason `no_series` |
| anomaly states | none |

Zero, and correctly so: `seed:demo` declares no signal with `forecast_enabled` (0 rows), and
the forecast pass has never run on it, so there is no forecast and no hourly rollup to
score. 370,692 simulated readings exist; none of them is a forecast. This run proves the
CLI, the ledger, the dataset label and the null-with-reason path end to end. It measures
nothing about TTM.

The other two kinds refuse to start and say why (exit 2):

- `retrieval`: *"QEVAL1b: waits on QEMB1 (pgvector on Railway) and a golden set authored by domain experts"*
- `recommendation_replay`: *"QEVAL1c: waits on QREC2 (the deterministic renderer)"* — runs
  since QEVAL1c; see part 1c below.

## What the backtest measures, when there is data

Per `(model, signal role, lead time)`, pooled across machines in `eval_run.summary` and per
machine in `eval_result` (tenant-owned):

- **MAE** of the model, of **persistence** (last actual before the origin) and of a
  **seasonal** baseline (the same hour a whole number of days earlier, as many days as it
  takes to land at or before the origin, so no lead reads an actual from after the forecast
  was made).
- **MASE-style scaled MAE**: each error divided by the series' own mean one-step change,
  taken over the evaluated window rather than only before each origin, because the rollup
  keeps 90 days and an origin near its start has almost no history of its own.
- **Interval coverage**: `null` with reason `no_interval_on_forecast` today, because QML1
  writes the daily sample with `lo`/`hi` null. It counts as soon as a sample carries one.
- A step is scored only when its actual, persistence origin and seasonal actual all exist,
  so the model and its baselines are compared on the same steps; every other step is
  counted under why (`no_actual`, `no_persistence_origin`, `no_seasonal_actual`,
  `step_mismatch`, `empty_forecast`).
- **Rolling-origin replay** (`--replay-days N`): one origin per UTC midnight, contexts built
  by QML1's `buildContext` from the hourly rollup, forecast by QML1's own worker through
  `runWorker`, with the same weights check the pass makes. Written to `eval_result` only.
- **Anomaly states**, described, not scored: how often each `(machine, signal)` was
  `normal`, `anomalous` or `baseline_not_established`, judged against a band learned from
  the days before each residual's own; and how many anomalous stretches had an alert on
  the same signal, or a work order on the machine, within 24 hours after. Reported as
  overlap, never as precision (G07).

What it does not apply: QEVAL1 §2 lists "imputed context above QML1's limit" as an exclusion.
The daily sample does not record its input coverage or imputed-step count, so that exclusion
cannot be applied to it. The replay's contexts pass `buildContext`'s own floor.

## Before you read a number from it

- Actuals are `forecast_input_bucket`, the hourly means the model is fed, not raw readings.
- A seeded run is labelled seeded whatever it was asked to be: any simulated telemetry in
  the window relabels the run, and its summary says no model-quality claim is made.
- Nothing is gated (question 2). Deepak sets targets against the naive baselines.

---

# Part 1c — the recommendation replay

Run 20 October 2026 from branch `feature/qeval1c-replay`, which is stacked on QEVAL1a (!132)
and QREC2 (!133).

## Verdict

**Built, and every measurement works on hand-worked fixtures. No real number exists yet.**
On seeded data the template renderer was grounded at every moment and honest about missing
history, and selection had nothing to be measured against.

## The smoke run on seeded data

A fresh local database (`ta2_qeval1c_smoke`, all 88 migrations), `seed:demo` with
`SEED_DEMO_ENABLED=true`, then:

```
npm run eval -- --kind recommendation_replay --dataset seeded \
  --note "local seed:demo, 20 Oct 2026" --out qeval1c-smoke.json
```

| | |
|---|---|
| status | `completed`, exit 0 |
| dataset | `seeded` (*"seeded alerts and work orders measure the seeder, not the engine"*) |
| versions | scorer `qeval1c-1`, engine `rec-engine@1`, renderer `rec-frame-templates@1`, template path only |
| machines | 6 classified, 6 replayed, 0 unreached |
| moments | 7: one alert's firing, and each machine's window end |
| grounding | 7 frames, **0 failed** |
| coverage honesty | 5 moments without history, **0 violations** |
| selection | 0 labelled: `rate: null`, reason `insufficient_history` |
| written | 6 `eval_result` rows; **0** `rec_evidence_bundle`, **0** `rec_frame` |

`seed:demo` raises one alert and no work orders, so there is nothing to label a selection
with. The run proves the replay end to end. It measures nothing about the engine.

## What it measures

At each moment — every alert's firing in the window, plus the window's end — QREC1's five
steps run **as of that moment**, in memory, and QREC2's template renderer frames the result.

1. **Grounding.** QREC2's critic (refs resolve, numbers trace to the bundle, no time after
   `as_of` without a forecast run, aims verbatim, no probability words), plus one check the
   critic does not make: no failure mode name, signal or action from the account's library
   appears in a sentence unless the bundle carried it. A failure names its check.
2. **Coverage honesty (D21).** Where the precedent search had no history, the frame says
   "No history to search" and never "similar" or "occurred".
3. **Selection against recorded work.** For each moment followed by labelled work, did the
   frame's first next step address the labelled failure mode? Reported as agreed, disagreed
   and no selection, over the count of labelled moments. A machine with no history, or no
   labelled moment, reports `insufficient_history` and no rate (D28).

## Before you read a number from it

- **The label is derived, not recorded (question 4).** A work order has no failure mode
  field. The label is a completed work order raised from an alert whose rule watches a
  signal exactly one of the class's failure modes names. That shares the alert's signal
  with the attribution step, so agreement says the selection followed the recorded work.
  It does not say either was right. A failure mode recorded on the work order would make
  this a real label; that is a change to work orders, not to this eval.
- **"As of" is partial.** Alerts, work orders, service records and incidents are put back as
  they stood at each moment, from their own timestamps. The library, alert rules, signal
  bindings and parameters are read as they are now; none of them keeps history. A cancelled
  work order counts as cancelled from its last update, because cancelling records no time.
- **The language-model renderer is not evaluated (question 8).** `REC_FRAME_MODEL_ENABLED`
  is read once per process, so it cannot be on for the eval namespace alone.
- Nothing is gated (question 2).
