**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QEVAL1 — TTM backtest, retrieval eval, recommendation replay eval

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

Also read `docs/ai/decisions/ai-layer-decisions.md` **D20, D21, D22, D26, D28, D36 and D40**,
`docs/ai/DECISIONS.md` **D08 and D09**, START-HERE's **G07 and G10**, and the retrieval
paragraph of `docs/ai/layers/01-SHARED-CONTRACT.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/qeval1`

**Depends on:** QML1 (forecasts, residuals, `forecast_daily_sample`), QREC2 (the framed
recommendation), and through QREC2, QREC1 and QEMB1 (the retrieval index). **QEMB1 is
blocked on a pgvector-capable Postgres image on Railway.** Until it lands, part 2 below has
nothing to evaluate. Part 1 can start as soon as QML1 merges. Parts 2 and 3 wait. Question 1
decides whether this is one task or three.

---

## 0. Why

Three components will each produce something a person acts on, and each can be wrong in a way
nobody sees on screen:

- **A forecast** looks equally confident whether it is good or poor. D26 makes every future
  number trace to a model run. Provenance says where a number came from, not whether it was
  right.
- **Retrieval** that misses the right library entry or OEM passage fails silently. The answer
  is built from what *was* found, and it reads fine.
- **A recommendation** picks a library entry and attaches evidence (D22). The failure D22
  names is "a wrong pick from a valid list", which also reads fine.

QEVAL1 measures each of these against what actually happened. It produces numbers and does
not set a pass mark. **No acceptance target exists in any decision file.** START-HERE lists
"model acceptance target" among the facts that need a human, not an inference. Every metric
below is reported. None is gated until Deepak sets a target (Question 2).

## 1. The rule all three parts share: an eval never touches live state (G10)

Evaluation reuses the production calculation code and runs in **its own run namespace**. It
may not:

- send a notification, raise an alert, create a work order or an action item
- write to `forecast_latest`, `forecast_residual`, any band, or any live baseline
- change a model's `status` in the registry (G10: replay cannot approve models)
- write to any table a production reader reads

Results go to `eval_run` and `eval_result` only. Each row carries `run_id`, the kind
(`ttm_backtest` | `retrieval` | `recommendation_replay`), the exact versions evaluated (model id,
embedding profile, library class versions, renderer version), the data window, and the dataset
it ran on. Rows are **immutable** once the run completes, enforced by a trigger. An eval result
that can be edited afterwards is not evidence.

COVERAGE.md marks G10 **partial**: "No general run namespace, no `run_id` on results". This
task builds a run namespace for evaluation. It does not retrofit one onto activation's
preview.

**Absence is a result, not a zero.** D21: "no history to search" is not "no similar cases".
Every metric reports its denominator: series scored, queries run, windows replayed. A metric
over zero items is `null` with a reason, never `0` and never `100%`.

## 2. Part 1 — TTM backtest

**Input:** `forecast_daily_sample` (D40 §5 retains it for exactly this), plus actuals at the
same step resolution as the forecast. The step resolution is whatever QML1 settled; read it from
the rows, do not assume it.

**Per `(model, signal role, lead time)`, report:**
- MAE, and MAE scaled by the same series' naive error (MASE-style), so a signal measured in
  hundreds and one measured in fractions can be compared
- the same two numbers for two **naive baselines**: persistence (last value carried forward),
  and same-hour-yesterday. A model is only worth its dependency if it beats these. A backtest
  without a naive baseline reports a number with nothing to compare it to.
- **interval coverage**: the fraction of actuals inside `[lo, hi]`, against the level the
  interval claims, if QML1 ships intervals
- the count of series and steps, and the count excluded and why (no actual, stale, imputed
  context above QML1's limit)

**Rolling-origin replay over the hot window.** The daily sample covers only the days since QML1
went live. To get more, run the real model through QML1's own worker over historical windows
inside the D14 90-day hot window, writing only to `eval_result`. This is the one place QEVAL1
invokes the model. It goes through QML1's `forecast-main` code path with an eval namespace,
not a second inference implementation.

**Anomaly states, described but not scored.** Report how often each `(machine, signal)` was
`normal`, `anomalous` and `baseline_not_established`. Report how many `anomalous` stretches
overlapped a later alert or work order on the same signal. **Do not call that overlap precision.**
G07 forbids fabricated labels, and an alert is not a label that a fault occurred. The overlap is
reported as overlap.

## 3. Part 2 — retrieval eval

**What is evaluated:** the retrieval QEMB1 builds, as the shared contract specifies it: top 30
semantic plus top 30 lexical candidates, exact-identifier matches included, RRF with constant
60, deduplicated to at most 8 chunks. Returned as `RetrievalHitV1`. Evaluate the configuration
that ships, against the embedding profile it is pinned to (D08). A result is tied to that profile
id. A reindex makes it a different result.

**Golden set:** queries, each with the chunks or library entries a correct answer must find. QEVAL1
builds the harness and the storage. **It does not author the golden set.** Who does, and from
what, is Question 3. A golden set written by the same model being evaluated measures agreement
with itself.

**Report, per query and in aggregate:** recall@8 (the contract's cut-off), MRR, and the split by
`retrieval_methods`: how many expected hits came only from semantic, only lexical, only exact
identifier. That split is the evidence for or against the hybrid design.

**Isolation, attempted (G01).** COVERAGE.md lists retrieval among the surfaces "unproven by absence
rather than by test". For each golden query, run it as a second tenant that does not own the
expected content, and assert **zero** hits on the first tenant's documents. That holds for the
semantic branch, the lexical branch and the citation path alike, which is D09's whole reason for
one store. This one *is* gated, with no target needed: a single cross-tenant hit fails the run.

## 4. Part 3 — recommendation replay eval

**What is replayed:** QREC1's five deterministic steps and QREC2's deterministic renderer (D36),
over historical windows for machines that have them, in the eval namespace. The language-model
path behind QREC2's flag is evaluated **only if** the flag can be turned on in the eval namespace
without turning it on anywhere else. Otherwise it is not evaluated, and the report says so.

**Three measurements. The first needs no labels.**

1. **Grounding, mechanical.** Every number and every named signal, failure mode or procedure in a
   rendered recommendation must appear in its evidence bundle or the selected library entry.
   Check it by extraction and comparison, not by a model. D26 adds: **any future-tense number must
   trace to a forecast run id.** One untraced number fails that recommendation. Report the failure
   rate and list every failure. With the deterministic renderer this should be zero. A non-zero
   count is a renderer defect, and the report names it.
2. **Coverage honesty (D21).** For every step, check that "no history to search" was reported
   whenever the precedent search had no history, and never replaced by "no similar cases occurred".
   Attempt it deliberately on a machine with no history.
3. **Selection against what happened.** For windows where a work order was later raised and
   closed with a failure mode, did the recommendation select a library entry for that failure mode?
   Report the agreement rate **with its denominator**, and label it as agreement with recorded work.
   It is not accuracy. Whether closed work orders are a fit label at all is Question 4.

**Replay on a machine with too little history** reports `insufficient_history`. It does not
report agreement, mirroring D28's third outcome.

## 5. Which data it runs on

**Seeded demo telemetry (`seed:demo`) is synthetic.** A backtest over it measures the seeder's
generator, not TTM. A retrieval or replay eval over it is a smoke test. Every run records its
dataset, and the report **must not present a seeded-data number as model performance.** Which
real data the evals run on is Question 5.

## 6. How it is run

- A CLI entry, `npm run eval -- --kind <kind> [--window …]`, that writes an `eval_run` and its
  results and prints the summary. No HTTP endpoint in this task (Question 6).
- Per-tenant work runs under `withTenantId`. Any enumeration across tenants uses
  `runTenantSpanning` with a reason string, exactly as the shift runner does. CI allows
  `ta.bypass` nowhere else.
- `eval_run` takes an advisory lock per kind. Two runs of the same kind do not interleave their
  writes.
- Each kind has a time and row budget. A run that exhausts it records `budget_exhausted` and what
  it did not reach. It does not record a partial result as complete.

## 7. Files

Create:
- `src/evaluation/`: module, `eval_run` / `eval_result` entities, one service per kind
- `src/eval-main.ts`: the CLI entry
- `src/database/migrations/<ts>-Evaluation.ts`: timestamp assigned immediately before the MR
- `test/evaluation.spec.ts`
- `docs/ai/measurements/QEVAL1.md`: the first run's report

Change, and say why in the MR:
- `package.json`: add the `eval` script, and append `test/evaluation.spec.ts` to `test:db`.
  No dependency.
- QML1's forecast pass, **only if** it needs an eval-namespace parameter to write to
  `eval_result`. If that change is more than a parameter, stop and report.

## 8. Out of scope

- Setting acceptance targets, or gating on any quality metric except the cross-tenant isolation
  check.
- Authoring the golden set.
- Changing the model, the retrieval configuration, the library or the renderer because of a
  result. Report it. The fix is its own task.
- Approving or activating a model (G10).
- A UI or an endpoint for results.
- Anything under `frontend/`.

## 9. Tests

**Refusals, attempted:**
1. An eval run tries to write `forecast_latest`, raise an `alert_event` or create a work order
   through the shared code path → refused. Assert the live tables are unchanged.
2. `UPDATE eval_result …` after its run completed → the trigger refuses it.
3. An eval run tries to change `forecast_model.status` → refused.
4. Tenant B reads tenant A's `eval_result` rows under its own session → zero rows (if results are
   tenant-owned; see Question 7).
5. Retrieval isolation: a query as tenant B against tenant A's content → zero hits, and the run
   fails if there is one. Test it by planting a hit and asserting the run fails.

**Behaviour:**
6. Backtest on a fixture with known forecasts and actuals → MAE and the naive baselines equal
   hand-computed values. Assert exact numbers.
7. A backtest over zero scorable series → `null` with a reason, not `0`.
8. A rendered recommendation containing a number absent from its bundle → grounding failure
   recorded, naming the number.
9. A future-tense number with no forecast run id → grounding failure (D26).
10. Replay on a machine with no history → "no history to search" reported, and
    `insufficient_history` for selection.
11. A run that exceeds its budget → `budget_exhausted`, with the unreached items listed.
12. A seeded-dataset run is labelled as seeded in `eval_run`.

**Concurrency:**
13. Two runs of the same kind fired together (`Promise.allSettled`) → both settle. One runs, one
    reports the lock held. Results written once.

**Migration:**
14. Down path, naming its own migration: `undoMigrationNamed(owner, 'Evaluation<ts>')`, with rows
    seeded first. QML1's tables are untouched.

**Seed before you migrate.**

## 10. Done when

- `npm run build && npm run test:db` pass. Before and after counts on a worktree off
  `origin/main`, naming the base SHA. The delta equals the new spec's count.
- `npm run lint` and `npm run verify:migrations` clean. The chain runs from empty.
- One real run of each available kind, with `docs/ai/measurements/QEVAL1.md` carrying the numbers,
  their denominators, the dataset each ran on, the exact versions evaluated, and which kinds could
  not run and why.
- Report: files created, files changed and why, test counts with base SHA, and every assumption
  made.
- Commit and push. Open the MR. Do not merge.

**One line for the task doc:** a forecast, a search result and a recommendation all read
equally well when they are wrong. This measures each against what happened, with its
denominator, and leaves the pass mark to a person.

---

## Questions — answer before starting

1. **One task or three?** Part 1 needs only QML1. Part 2 needs QEMB1, which is blocked on pgvector.
   Part 3 needs QREC2. *Recommendation:* split into QEVAL1a (backtest, after QML1), QEVAL1b
   (retrieval, after QEMB1) and QEVAL1c (replay, after QREC2), with the shared `eval_run` namespace
   landing in 1a. Otherwise the backtest waits on an unrelated infrastructure blocker.
2. **Acceptance targets.** None is recorded. *Recommendation:* run once and report. Deepak then
   sets targets against the naive baselines (for example "beats persistence at lead times up to
   N hours"), recorded as a dated decision. Until then, nothing but isolation is gated.
3. **Who authors the retrieval golden set, and from what?** *Recommendation:* domain authors
   write real questions per equipment class from OEM manuals already in the corpus, each with its
   expected chunk. Deepak sets how many. The model under evaluation must not generate them.
4. **Are closed work orders with a failure mode a fit label for selection?** They record what a
   technician wrote, not necessarily what failed. *Recommendation:* use them, but report the result
   as "agreement with recorded work", never as accuracy (G07).
5. **Which data?** Seeded data measures the seeder. Real data needs `LEGACY_DB_*`, which is still
   blocked (DECISIONS.md, open items). *Recommendation:* real development-tenant telemetry once the
   adapter is live. Until then, seeded runs only, labelled as smoke tests, with no model-quality
   claim made.
6. **Results endpoint?** *Recommendation:* none yet. The CLI plus the report file is enough until
   someone needs to read results without a terminal. Then add a platform-staff read endpoint.
7. **Are eval results tenant-owned or platform-owned?** A backtest of tenant A's machines is
   derived from tenant A's data, but D39 says Things Alive keeps no platform read path into
   client data. *Recommendation:* tenant-owned rows under RLS for per-machine results, and
   platform-level rows for aggregates only, with no machine identifiers. Confirm the aggregate rows
   are acceptable under D39.
8. **Does part 3 evaluate the language-model path at all** while QSPIKE1b's result is unknown?
   *Recommendation:* only if QREC2's flag can be scoped to the eval namespace. Otherwise
   deterministic only, and say so.
