# Platform 2.0 — task register

**This file is the reference. Check it instead of searching GitLab.**

Verified against GitLab on **2026-09-24**, branch `main` @ `1106bc74`
(evidence: migration tree under `src/database/migrations`, plus commit titles on `main`).

Method unchanged: task prompts are written by the architect, **Claude Code CLI executes them
on the laptop**, Deepak reviews the diff and commits. Working rules for every CLI session
are in `CLAUDE.md` at the repo root. Prompts live in `docs/ai/tasks/`.

**Status vocabulary — only these three:**

| Status | Meaning |
|---|---|
| **Complete** | merged to `main` on GitLab, SHA recorded below |
| **In progress** | prompt issued to the CLI, not yet merged to `main` |
| **Not started** | no prompt issued |

A prompt written but not handed over is **Not started**. Code written but not merged is
**In progress**. Only a merged SHA moves a row to Complete.

---

## 1. Complete — merged to `main`

### Platform baseline (before the current work stream)

Present in the migration chain, not re-verified line by line: projections and RLS, catalog
and client-owned catalog, activation, prediction runtime, device inventory, identity and
credentials, tenancy, equipment register, work orders, equipment shifts, late arrivals,
alerts, shift-run ledger, fuel-loss trigger, utilisation, service records, device link
health, causal chains, alert rule templates, sensor category and catalog, tool mapping,
equipment template, tenant role allowed tabs, template read capabilities.

### Current work stream

| | Task | Commit | Migration |
|---|---|---|---|
| **Q08S s1** | Signal binding schema — a machine's signals bound rather than guessed | `f222d0e0`, `a178e6a5`, `15266398` | `1757960000000-SignalBindings` |
| **QPA1** | Platform admin authentication — sign-in, refresh, sign-out, change-password, lockout, suspension, session revocation, `staff:bootstrap` | `b695799e` | `1757900000000-PlatformStaff` |
| **QL1** | Equipment library schema — sensor requirements, role capabilities, formula registry (`compiled_plan` reserved) | `13d05754` | `1757970000000-LibraryStructure` |
| **QIMP1** | Catalog import workbook template and streaming parser | `273715cd` | `1757980000000-CatalogImport` |
| — | `projection.spec` — build schema once, truncate between tests | `b61b7376` | — |
| — | Template **v2** — thresholds mirror the alert engine's min/max bounds | `79451793` | — |
| **QIMP2** | Import validation, dry-run diff, endpoints under `/platform/catalog/imports` | `d8b7fa01` | — |
| **QIMP3** | Apply — one transaction, published versions immutable, row provenance, identical content mints no new version. Template **v3** landed in the same commit. | `828fdff2` | `1757990000000-CatalogImportProvenance` |
| **QPA2** | Staff management — `/platform/staff` list, invite, change role, suspend, reinstate, invitation-and-accept | `3555757b` | `1758000000000-PlatformStaffInvitations` |
| — | Capability split — `catalog.write` loads, `catalog.publish` publishes | `3555757b`, completed by `170a3928` | — |
| **Q08S s2** | Coverage and discovery — two independent mapping sources, three result sets, resolve-at-event-time, readable validity-window errors | `3555757b` | — |
| — | **Security** — stop returning `passwordHash`; auth tests independent of `.env` | `4d52aaa0` | — |
| — | **CI unblocked** — the console job pointed at `web/`, deleted in D17. `setup-node` could not resolve its cache path, failed in 4s, and Railway's Wait for CI refused **every** deploy for five days. Job repointed at `frontend/` with the committed lockfile and renamed `Console build` (frontend's build script is `vite build` alone and does not type-check). `.dockerignore` `web/` → `frontend/` — the backend build context had been shipping the whole frontend tree. | `58c88f3`, `b137add` | — |
| **QALERT1** | Explicit alert evaluation — last 10 readings per `(imei, signal)`, reduced by bound direction; windows under 3 readings do not fire; `SIGNAL_THRESHOLD_PARAM_SOURCE` classifies every engine parameter as staged or defaulted; plain-English renderer. Closes the dwell gap. | `db6e7bb9`, merged `f8fb366f` | none — params are jsonb |
| — | One rules file (`CLAUDE.md`), D17 corrected | `26758c38` | — |

Merged `feature/ai-layer` → `feature/dev` (`1b4117d8`) → `main` (`1106bc74`).

### Operations — done

- Deployed to Railway from the GitHub mirror, CI gating the deploy.
- First real master admin bootstrapped through the Railway tunnel; sign-in verified;
  `/api-docs` and `/platform/staff` confirmed live.

---

## 2. Wave 1 — deterministic foundations

Everything on a machine detail page resolves to a formula, a forecast or a rule. Nothing
downstream is worth starting before the compiler exists.

| | Task | Status | Needs |
|---|---|---|---|
| **QCE1** | **Formula compiler** — expression → `compiled_plan` at publish. Hand-written parser, closed operator registry, **compile-time unit inference**, scalar-vs-series typing, and **KPI presentation metadata** (D30). Never `eval`, never `new Function`. | **In progress** — committed `66086989` on `feature/calc-engine`, **not merged** | — |
| **QCE1** + **QCE1.1** | Formula compiler and its three corrections — unit-polymorphic literals, `#formula_key` composition with cycle refusal and transitive `required_signals`, and `result_kind`'s default dropped (D32). | merged via MR !38 | `1758010000000`, `1758020000000` |
| — | **Incident: migration order.** `1758020000000` ran `UPDATE ... SET result_kind = NULL` before `DROP NOT NULL`. Every local suite started from an empty table, so nothing violated the constraint and it passed; it failed on the first database with a real row. Transaction rolled back cleanly, old version kept serving. Reordered, plus a regression test that seeds a row under the old default. Standing rule added to `CLAUDE.md`: a migration test must seed the state it is changing. | MR !40 | — |
| **QCE1.1-old** | Corrections to QCE1: numeric literals are unit-polymorphic in `+`/`-`; formula-to-formula composition restored as `#formula_key` with a dependency DAG, cycle refusal and transitive `required_signals`; `result_kind` default dropped (D32) | **Not started** — prompt issued 2026-09-24, no commit on the branch | QCE1 |
| **QALERT2** | *(merged `!44`)* **Correct the alert reduction.** `requiredBreaches` (M, default 6) joins `lookbackReadings` (N, default 10); a bound fires only once ≥M of the last N readings individually breach it. `max`/`min` reduction gone. M outside `[1, N]` refused. Renderer: "Fires when at least 6 of the last 10 readings…". Boundary tests at 6/10 fires and 5/10 does not, and the single-spike case pinned by name. | **Complete** — `feb96c5`, MR **!44**. test:db 192/192, suite 373/373 | — |
| **QIMP4** | **Unblock the import loop.** Checksum uniqueness dropped; discard-batch endpoint; `incomplete_class` and `content_regression` diff warnings gated by `acknowledgeWarnings`; **one content validator shared by the import and the API authoring path**; `SELECT ... FOR UPDATE` on the batch row. | **Complete** — `892c6b5`, MR **!41** merged. test:db 171→180, suite 900→911 | — |
| — | **Finding: there was no duplicate-signal bug.** `duplicateKey()` was already `class::signal::component_scope`, and a static sweep of the parser, apply and diff services found no second duplicate check. The 39 `duplicate_in_batch` rejects were **byte-identical rows** — one physical sensor registered once per class, because `sensor_capability` is a **global** sheet and the template never said so. Authoring habit, exposed by a template that reads as per-class. | — | — |
| — | **Finding: there was no capability bug either.** `sensor_role_capability` is empty and **unrelated** — the validator joins `sensor` on `sensorName`. My "0 of 42 resolve" measurement used the wrong table. Both of my hypotheses were wrong; the CLI's measurements were right. | — | — |
| — | **Root cause, finally: the sensor catalog has 3 rows.** Every reject in both batches was `count === 0` — not found, never ambiguous. The workbook proposes ~40 sensors nobody ever created. Nothing was broken; the import correctly refused to invent a catalog. | — | — |
| — | **Finding: two write paths, one now validated.** `crane-400-kw` v1/v2 are `source='manual'`, `import_batch_id` NULL — written through the API, which had **no content checks at all**. Extracted to `content-validation.ts`, called from both. | — | — |
| — | **Finding: one batch minted two versions.** Two overlapping `apply()` calls both read `status='validated'` before either committed; `ex-1200v` v2 was written with `failure_modes: []`. Fixed with a row lock, reproduced with the lock removed. **Open: does the console fire apply twice on a double-click?** | — | — |
| — | **Rule added to `CLAUDE.md`.** Any endpoint that mutates an import batch takes the batch row lock; anything documented as idempotent gets a concurrent-call test. Reasoning recorded with the QIMP4/QIMP5 history. | — | — |
| **QIMP5** | *(merged `!43`)* **The sensor catalog.** Split `sensor_not_found` from `sensor_ambiguous`. `sensor.slug` NOT NULL unique, backfilled with collision suffixing; resolution slug-exact → name-fallback. Identical global rows dedupe silently, conflicting ones error. `proposedSensors` + `proposedCategories` in the diff, create-on-approval in one call, re-validate **without re-upload**, apply refused while proposals are outstanding. `catalog_import_batch.sensor_decisions` records who approved what. | **Complete** — `e33fd12`, MR **!43**. test:db 192→215, suite 923→945 | `1758060000000-SensorSlugAndApprovals` |
| — | **Decision: the apply gate is unconditional.** `acknowledgeWarnings` means "I accept an incomplete class", not "I accept a missing referent". The escape hatch is dismiss → `incomplete_class` → `acknowledgeWarnings` — two recorded acts. | — | — |
| — | **Decision: `catalog.write` covers approval.** Accepting content a workbook proposed is the same category of act QIMP2 already gated. `device-catalog.write` still gates direct, workbook-independent sensor authoring. | — | — |
| — | **Finding: a second race, found by writing the test.** Two concurrent approvals on one batch: the second threw once the first committed, contradicting the documented idempotency. Fixed by falling back to `sensorDecisions`. **That is two concurrency bugs in this subsystem** — QIMP4's apply and QIMP5's approval. Standing rule for `CLAUDE.md`: any endpoint that mutates a batch takes the batch row lock. | — | — |
| — | **Answered: no base seed exists.** A fresh database ships an empty sensor catalog by design; `seed-demo-fleet.ts` is demo-only. The template's example `sensor_capability` row is real importable content and stays. It was harmless while unresolved rows were skipped; the unconditional gate is what made it a stop — which is the correct first-use experience. | — | — |
| **QCAT2** | **Retire vs delete** on sensor capabilities. Retire always allowed, keeps existing references working, removes it from pickers. Delete only when nothing references it. | Not started | — |
| **QCE3** | *(merged `!45`)* **Named formula catalogue** (D33) — platform registry of physics formulas written against roles; Excel `formula` sheet gains bind mode; dimension check at bind time, `suspicious_binding` warning gated by `acknowledgeWarnings`; seven seeded formulas, all compiled at migration time. | **Complete** — `982e923` (rebased), MR **!45**. test:db 192→212, suite 923→943 | QCE1.1 |
| — | **Decision: dimension *is* unit.** No separate dimension taxonomy — `units.ts` opaque-symbol equality reused. The system has never done conversion or dimension-awareness, so named formulas inherit that honestly. The coolant-vs-oil limit is structural, not a caveat. | — | — |
| — | **Finding: `dist/` carried an orphaned migration** from another branch's build; `tsc` does not prune. It was riding in the chain silently. Fixed in QGRANT0 §5 — clean `dist/` on build, CI asserts compiled count equals source count. | — | — |
| **QGRANT0** | **Copy-on-grant carries everything the class owns.** `copy-on-grant.service.ts` has **never copied formulas** — named or hand-written — so a granted class reaches the tenant with no KPIs and the D29/D30 machine page renders empty. Plus a declared inventory of class-owned tables and a test that fails on any unlisted one, so the omission cannot repeat. Re-grant semantics made explicit. | **Complete** — `4478679`, MR **!46** | QCE3 |
| — | **§3 audit, live against `main`.** Nine class-referencing tables, all now with a disposition: `alert_rule`, `alert_rule_template`, `causal_chain`, `client_catalog_entitlement`, `equipment_class_formula`, `equipment_class_sensor_requirement`, `equipment_profile`, `scenario_definition`, `utilization_shift`. The test fails on any unlisted one. | — | — |
| — | **§4, what re-grant did before.** `classes.findOne({tenantId, slug})` checked presence only. Any hit — same version, older, anything — took one no-op branch, returned `alreadyPresent: true` and copied **nothing**. A tenant re-granted after a newer version published received nothing, indistinguishable from one who had deliberately customised. | — | — |
| **QCE4** | **Baseline operators.** `baseline_avg`, `baseline_sd`, `zscore`, `delta_ratio`. `zscore` and `delta_ratio` infer **dimensionless**. Current period excluded from the baseline. 14-day minimum → `baseline_not_established`; `delta_ratio` checks it against `w2` only, since 14 days inside a 7-day window is unsatisfiable. Dirty-window exclusion wired for **both** alerts and work orders. New duration literal (`90d`, `24h`) in the parser — no in-expression syntax existed to match. | **Complete** — `45f32b0`, MR **!48**. test:db 246→261 | QCE1, QCE3 |
| — | **Open from QCE4: the cross-sensor risk score does not compose.** The z-score sum works; "count how many exceed 2" does not — the grammar has no comparison operator and no boolean-to-number cast. Scoped as **QCE5**: comparison operators yielding dimensionless 0/1, plus a `count_exceeding` reduction. Small. After the library is loaded. | — | — |
| **fix/ci-green** | CI had been red across four merges. `recommendation.spec.ts` pinned `NOW = 2026-09-12`; the partition migration creates from `now() − 2 months`, so the seeded July data had no partition the moment wall-clock passed 2026-10-01 — a time bomb, not a regression. Dates made relative; shared Jest hook-timeout gap fixed across 5 `describeDb` files. | **Complete** — `283ab57`, MR **!47** | — |
| — | **Confirmed: backward partition creation shipped with QPART1.** `MAX_BACKFILL_MONTHS = 24`, so the historical backfill from the IoT backend is sound and a reading older than 24 months is refused rather than silently lost. This closes the question left open when QPART1 merged. | — | — |
| **QOPS2** | Branch protection, preview service, CORS. **Done except §1.** Preview live at `https://frontend-preview-development.up.railway.app` watching `feature/bulk-classes`, root dir `frontend`, Wait-for-CI off, one variable. `CORS_ORIGINS` read-append-verified. `docs/frontend-local-dev` is MR **!49**, open. | **§1 blocked** — no GitLab MCP tool reaches Protected Branches; **Deepak sets it by hand**, deliberately not delegated: the branch protection governs the agent's own merges | — |
| **QALERT1** | **Explicit alert evaluation** (D34) — `lookback_readings` (default 10) and reduction by bound direction on the alert rule; plain-English render-back; closes the parked dwell gap | Not started | — |
| **QOPS1** | **Migrate Railway config to Infrastructure as Code.** `railway.json` / `railway.toml` are deprecated and **stop working 2026-12-01**. That file holds `preDeployCommand: npm run migration:run` and the "Wait for CI" gate — both safety mechanisms fail silently and simultaneously if it lapses. Run `railway config migrate`, review `.railway/railway.ts` by hand, confirm both survived, deploy once to prove it. **Deepak only — the CLI is read-only on Railway.** | **Not started — do before end of October** | — |
| — | **Ops access established 2026-10-02.** Railway CLI v5.63.1 on the laptop with a project token, read-only. `railway status`, `railway logs --lines/--since/--filter`, `--build`, `--http --status`. Always pass `--lines` or `--since` — a bare `railway logs` streams and hangs the shell. Deploy evidence is now quoted from logs, not inferred from local runs. API URL: `https://api-development-154e.up.railway.app`. | — | — |
| — | **Scheduler state confirmed.** `TELEMETRY_PARTITION_MAINTENANCE_ENABLED=true` and `SHIFT_RUNNER_ENABLED=true`, both on the **scheduler** service — the API correctly runs neither. Partition maintenance passes every 86400s. Shift runner ticks every 5 min and logs DEBUG whether or not work is found — 288 lines/day of noise, worth quietening later. | — | — |
| **QCE2** | *(merged `!50`)* **Runtime evaluator** — execute `compiled_plan` over a window against partitioned telemetry. Result is always an envelope (value, unit, window, readiness, reason, coverage); `value` is `null` whenever readiness is not `ready` — never 0, never NaN. Closed executor registry with a test that every compiler operator has an executor. Coverage computed, gaps never zeros, division by zero is `undefined_result`. Tenant-scoped KPI endpoints. | **Complete** — `3dac0ad`, MR **!50**. test:db 261→272, suite 1015/1015 | QCE1, QCE3, QCE4 |
| — | **Measured, so stop thinking about caching.** One KPI over 12 h: ~35 ms. Twenty KPIs for one machine: ~40 ms. A 12-hour query touches **one** partition via index scan. Nothing here needs materialising at this scale. | — | — |
| — | **`expected_period_seconds` on `signal_binding_version`** had been written by Q08S s1 and never read by anything. QCE2 uses it as the declared-cadence source for coverage. Finding an unused column beats adding a second one that means the same thing. | — | — |
| **QCE2.1** | **`series` means a series.** `resultKind: 'series'` returns bucketed `{t,v}[]`; a series plan that cannot be bucketed **throws**, naming the formula key. Empty bucket → `v: null`, never omitted, never 0. Deterministic bucket ladder (1m…1d) targeting ~120 points; an override above 1000 points is **refused**, not truncated. Alert-based dirty-window exclusion wired — a raised alert dirties a baseline only when the rule's scope covers the equipment **and** the rule's signal is the baseline's input signal. | **Complete** — `35ca9a9`, MR **!52**. test:db 280→296, suite 1044/1044 | QCE2 |
| — | **A test was proving something adjacent to its name.** QCE2's divide-by-zero case used `coolant_temp_c/(x-x)`, which was accidentally series-kind and silently coerced to scalar. QCE2.1's "series that cannot be bucketed throws" caught it. Formula corrected, intent preserved. | — | — |
| — | **Known limit:** `#formula_key` composition in series mode throws rather than guess at bucketing semantics. A composed named formula cannot be charted yet. A clear error beats a wrong chart; scope it when someone needs it. | — | — |
| **QPARAM1** | Tenant parameters and cost profiles — **three client-owned scopes** (D39): client → site → equipment, effective-dated, per-field inheritance, source attribution, currency-conflict wipe, append-only. No platform scope; no platform read path. | Not started — prompt written, **hold until QCE1 merges** | QCE1 |
| **QPART1** | Monthly partitioning of `telemetry_reading` | **Complete** — MR **!42** merged after !41. Full 45-migration chain clean from empty on merged `main`; test:db 192/192 | `1758030000000-TelemetryPartitioning` |

QPART1 is a **cost** task (D24) *and* a blocker twice over: the replay gate (D28) scans 90
days per candidate rule, and the machine page (D29) reads a 12-hour series per widget.

**Scope change from the previous cut:** unit inference moved from QCE2 into QCE1, because
it is static analysis and its outcome is a refusal to publish (D30 part 2). QCE2 is runtime
execution only.

## 3. Wave 2 — library content structure

| | Task | Status | Needs |
|---|---|---|---|
| **Q08S s3** | **Telemetry freshness per signal.** `stale_after_seconds` on `equipment_class_sensor_requirement`, nullable, 900 s platform default. Resolution is the **tenant copy** then the default — never the platform class. Separates `no_readings` (never any reading) from `stale` (went quiet) — a commissioning task versus a maintenance call. Response gains `staleAfterSeconds`, `lastReadingAt`, `secondsSinceLastReading`. **No template bump** — v4 is QREC0's. | **Complete** — `40a4144`, MR **!51**. test:db 272→280, suite 1023/1023 | `1758090000000-SignalFreshness` |
| — | **Found a conflation in code I had just approved.** QCE2's `resolveSignalStatus()` only saw readings inside its read window, so a reading older than the window was indistinguishable from one that never existed — `stale` reported as `no_readings`. Fixed with an unbounded `latestPerSignal()`, decoupled from the value read. Test 5b pins it. | — | — |
| — | **Decision: `coverage()` does not reclassify on staleness.** It answers a configuration question; staleness is a runtime condition. Conflating them flips a machine to "missing" because it sat switched off over a weekend. It now annotates every requirement with `staleAfterSeconds` / `lastReadingAt` / `secondsSinceLastReading` and leaves covered/missing alone. | — | — |
| — | **Deferred to QPARAM1: a tenant cannot override `stale_after_seconds`.** Copy-on-grant correctly excludes the requirement table — version-pinning already answers *which value applies*. It does not answer *can the tenant change it*. Freshness is a parameter (client → site → equipment, effective-dated), not class content. | — | — |
| **QREC0a** | **Content structure and template v4.** Failure modes and recommendations become **rows, not jsonb** — a recommendation must point at a failure mode, and the blob is why `ex-1200v` v2 shipped with `[]` unnoticed. KPI presentation metadata on `equipment_class_formula` (D30). Forecast declarations per signal, default **false** (D40's cost control). **Template v4 — the one bump**, carrying `sensor_slug` as primary, `stale_after_seconds`, forecast columns, QCE3's bind columns, the seven presentation columns, and two new sheets. v3 workbooks keep loading. | **Next** — prompt issued 2026-10-05 | QCE3, Q08S s3 |
| **QREC0b** | **Page layout and the site class.** How a machine page is composed, widget order, and D30 part 3's site class as a first-class thing rather than a loose collection of machines. | Not started | QREC0a |
| **QREC0c** | **Visuals.** `equipment_class_visual`, per-signal anchors, assets in object storage (D38), an anchor naming an undeclared signal refused at publish. **Deliberately last** — it touches storage infrastructure we have not built and is the piece most likely to stall; it must not be able to hold up the other two. | Not started | QREC0a |
| **QPAGE1** | Composed page endpoint — `GET /api/equipment/:id/page` returning layout, widgets, bindings and **per-widget readiness** in four states (D29). Includes the **`list` twin** (readiness list, no picture, zero content) and the **`schematic` twin with its 2-D hotspot editor** — hotspots need placing, so the editor ships with them, not with Tier 1 (D38). | Not started | QREC0, QCE2, Q08S s3, QUI-WIDGETS |
| **QUPGRADE1** | **Class version upgrade flow.** Origin classification (`inherited` / `customised` / `tenant_added`) on every tenant-copied content type; an explicit upgrade with a diff the tenant accepts; orphaned content preserved and labelled; `geometry_version` change marks customised anchors `needs_recheck`. **Not previously scheduled anywhere** — D39 assumed it was free and it is not. | Not started | QREC0 |
| **QTWIN1** | The WebGL twin widget + **anchor-placement editor**. Model asset platform-owned and shared; anchors copied on grant then tenant-owned; a new tenant signal lands in an **unplaced tray**, never auto-assigned (D38/D39). | Not started | QPAGE1 |
| **QWF1** | Workflow assembly — selections + library → `WorkflowSpec` → compile to `alert_rule`, plus the plan-to-plain-English renderer | Not started | QCE2 |

Fold the Q08S s3 and QREC0 template changes into **one** v4 bump, not two.

QPAGE1 is the contract the UI team needs before building the machine detail screen. Until
it exists they should wireframe only.

## 4. Wave 3 — proposal substrate

| | Task | Status | Needs |
|---|---|---|---|
| **QGEN1** | `artifact_proposal`, scope declaration, provenance chain, the deterministic gate **including the historical replay harness**, approval routing. D25/D27/D28. | Not started | QPART1, QWF1, QREC0 |

## 5. Wave 4 — models

| | Task | Status | Needs | Why early |
|---|---|---|---|---|
| **QSPIKE1** | Measure the model stack on Railway rather than estimating it | **In progress** — report committed `1720281` locally, **branch not pushed** | — | Done its job: see D35. bge-small and TTM confirmed with huge margin; Qwen unproven. Cost $1.18. |
| **QSPIKE1b** | **Bounded retry of the LLM runtime.** Rebuild llama.cpp with explicit CPU flags, or try onnxruntime-genai, and get one completed Qwen3-4B inference with tokens/sec. **Hard budget: one attempt, one day, then stop.** | Not started | QSPIKE1 | The 4B failing with 3 GB spare rules out memory and points at the wheel. Worth one bounded attempt; not worth an open-ended hunt, because D36 means nothing depends on the answer. |
| **QML1-SIZE** | Measure the `scheduler` image size and cold-start time with `torch` added | Not started | — | D35: TTM needs PyTorch, not ONNX. The inference is nearly free; the dependency may not be. |


| | Task | Status | Needs | Est. |
|---|---|---|---|---|
| **QML1** | Model registry + Granite TTM (**PyTorch CPU, not ONNX** — D35) as a **separate process with its own entry point and lock**, invoked in the `scheduler` container; split to its own service on the D41 triggers. Forecast + residual anomaly with `baseline_not_established` as a third state (D20). Library declares which signals are forecast; four-hourly default; latest-forecast-only storage (D40). | Not started | QPART1 | ~$4/mo |
| **QEMB1** | pgvector + `embedding_profile` pinned to `bge-small-en-v1.5`, ONNX in-process | Not started — **blocked**: pgvector image on Railway | — | ~$2/mo |

## 6. Wave 5 — the engine

| | Task | Status | Needs |
|---|---|---|---|
| **QREC1** | The five deterministic steps: detect, attribute, precedent, gap, cost | Not started | QML1, QREC0, QPARAM1 |
| **QREC2** | Frame — **deterministic sentence templates over the evidence bundle and the selected library recommendation** (D36). A language model sits behind a feature flag, off by default, producing the same contract. Phase 1 ships either way. | Not started | QREC1, QEMB1 |
| **QGEN2** | KPI / formula emitter | Not started | QGEN1, QCE2 |
| **QGEN3** | Workflow emitter | Not started | QGEN1, QWF1 |

Prediction has no emitter, by decision (D26).

## 7. Wave 6 — cost and proof

| | Task | Status | Needs |
|---|---|---|---|
| **QARCH1** | Parquet export, verify-then-drop, per-tenant prefixes | Not started | QPART1 |
| **QEVAL1** | TTM backtest, retrieval eval, recommendation replay eval | Not started | QML1, QREC2 |

### Deferred

| | Task | Status | Why |
|---|---|---|---|
| **QLLM1** | Form-filler (Qwen3-1.7B) | Deferred | ~$11/mo for convenience. Revisit once real cost is measured. |

---

## 7b. UI workstream

Owned by the UI team, tracked in `ui-team-tasks.md`. Demo code (`things-alive-demo`) is
being ported into `frontend/` as the client module.

| | Task | Status | Blocks / blocked by |
|---|---|---|---|
| **UI-00** | **Fix `AdminManagement.tsx:341` and re-enable the type check.** Declare `onNavigateToAISetup` on `DeviceManagementProps`, then add `npm run lint` before `npm run build` in the console job and rename it back to `Console types and build`. | Not started | **do first** — nothing type-checks `frontend/` right now |
| **UI-01** | Port demo into `frontend/` | Not started | UI-00 |
| **UI-02** | **Name the widget types** — closed vocabulary for page layout | Not started | **blocks QPAGE1** |
| **UI-03** | Auth: two sign-in surfaces, refresh rotation, invitation accept | Not started | — |
| **UI-04** | Fix `lib/rules.ts` — drop `.strict()` at boundary, add `lookbackReadings`, severity map, both bounds | Not started | QALERT1 |
| **UI-05** | Fix AI contract — remove equipment authoring, remove OpenAI client | Not started | — |
| **UI-06** | Readiness in four states on every screen | Not started | Q08S s3 |
| **UI-07** | Cost model onto the real API (schema unchanged — it is being adopted) | Not started | QPARAM1 |
| **UI-08** | Machine page rendered from `GET /equipment/:id/page` | Not started | QPAGE1, UI-02 |
| **UI-09** | Twin Tier 0 — schematic + 2-D hotspots, unplaced tray | Not started | QPAGE1 |
| **UI-10** | Screens buildable today: staff, accounts, library import, users, Things list, costs | Not started | — |
| **UI-12** | 3D twin widget + anchor editor | Not started | QTWIN1 |

**UI-02 is the one to chase.** The backend cannot serve page layouts until the widget
vocabulary is named, and it is a day's work of cataloguing what the demo already contains.

## 8. Not started — not development

| | Item | Status | Owner |
|---|---|---|---|
| 1 | Rotate the Railway Postgres password — it was pasted into a conversation | Not started | Deepak |
| 2 | Close the tunnel; discard the staged public endpoint on Postgres | Not started | Deepak |
| 3 | The GitHub mirror repository is **Public** — decide deliberately | Not started | Deepak |
| 4 | Invite the UI team as `catalog-author` | Not started | Deepak |
| 5 | Author library content — classes, signals, thresholds, formulas, failure modes, recommendations | Not started | Deepak / domain |
| 6 | UI settings screen for **tenant parameters** (tariff, downtime cost/hour, labour rate, parts cost). D31 blocks revenue KPIs and costing until it exists. | Not started | UI team |
| 7 | UI: readiness as **four** states, never a red dot | Not started | UI team |
| 8 | `LEGACY_DB_*` credentials | Blocked externally | — |
| 9 | Domain review of operating limits | Blocked externally | — |

## 9. Parked

- ~~Alert engine has no dwell time.~~ **Resolved by D34** — scheduled as QALERT1
  (`lookback_readings`, default 10).
- `catalog.read` guards reads of a tenant's own equipment. Consistent but misnamed.
- Duplicate `changeOwnPassword` / `changePassword` methods.
- `.gitattributes` with `* text=auto eol=lf` to stop CRLF churn between Windows and CI.

---

## 10. Next

**As of 2026-10-05.** `main` carries, in order: QIMP5 → QALERT2 → QCE3 → QGRANT0 →
fix/ci-green → QCE4 → QCE2 → Q08S s3 → QCE2.1, plus the `AGENTS.md` ignore (!39) and the
local-dev note (!49). **The deterministic layer is complete end to end**: compile, bind,
evaluate, bucket, and a readiness state for every absence.

Deployed at `https://api-development-154e.up.railway.app`.
Preview UI at `https://frontend-preview-development.up.railway.app`.

**In flight:** QREC0a (content structure, template v4).

**Running in parallel:**

| Who | What |
|---|---|
| Library team | load content via the runbook, then run `test-plan-development.md` — 48 cases, Swagger only, no console needed |
| UI team | **!53** (`feature/clientflow`, Scenarios / Work Orders / Thing Detail) awaiting review; `feature/bulk-classes` still needs a rebase and the Catalog Import rework |
| Deepak | protect `main` (two clicks, still outstanding); **QOPS1 before end of October** — `railway config migrate`, since `railway.json` stops working 2026-12-01 and takes `preDeployCommand` and the CI gate with it |

**Then:** QREC0b → QPAGE1. QREC0c last by design. QCE5 (comparison operators, the one ITDC
shape still missing) after the library is loaded.

**Housekeeping:** MRs !23–!27 and !31 target superseded branch chains and have been open
three weeks. Close them — they make the real queue unreadable.

**This file is the authoritative register and lives at `docs/ai/task-register.md`.** Deepak
maintains it; the CLI commits what he sends and does not edit it.
