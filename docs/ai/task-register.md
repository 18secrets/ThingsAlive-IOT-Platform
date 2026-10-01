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
| **QALERT2** | **Correct the alert reduction.** `requiredBreaches` (M, default 6) joins `lookbackReadings` (N, default 10); a bound fires only once ≥M of the last N readings individually breach it. `max`/`min` reduction gone. M outside `[1, N]` refused. Renderer: "Fires when at least 6 of the last 10 readings…". Boundary tests at 6/10 fires and 5/10 does not, and the single-spike case pinned by name. | **In progress** — `feature/alert-breach-window` off `main`, MR open, **not merged**. test:db 192/192, suite 373/373 | — |
| **QIMP4** | **Unblock the import loop.** Checksum uniqueness dropped; discard-batch endpoint; `incomplete_class` and `content_regression` diff warnings gated by `acknowledgeWarnings`; **one content validator shared by the import and the API authoring path**; `SELECT ... FOR UPDATE` on the batch row. | **Complete** — `892c6b5`, MR **!41** merged. test:db 171→180, suite 900→911 | — |
| — | **Finding: there was no duplicate-signal bug.** `duplicateKey()` was already `class::signal::component_scope`, and a static sweep of the parser, apply and diff services found no second duplicate check. The 39 `duplicate_in_batch` rejects were **byte-identical rows** — one physical sensor registered once per class, because `sensor_capability` is a **global** sheet and the template never said so. Authoring habit, exposed by a template that reads as per-class. | — | — |
| — | **Finding: there was no capability bug either.** `sensor_role_capability` is empty and **unrelated** — the validator joins `sensor` on `sensorName`. My "0 of 42 resolve" measurement used the wrong table. Both of my hypotheses were wrong; the CLI's measurements were right. | — | — |
| — | **Root cause, finally: the sensor catalog has 3 rows.** Every reject in both batches was `count === 0` — not found, never ambiguous. The workbook proposes ~40 sensors nobody ever created. Nothing was broken; the import correctly refused to invent a catalog. | — | — |
| — | **Finding: two write paths, one now validated.** `crane-400-kw` v1/v2 are `source='manual'`, `import_batch_id` NULL — written through the API, which had **no content checks at all**. Extracted to `content-validation.ts`, called from both. | — | — |
| — | **Finding: one batch minted two versions.** Two overlapping `apply()` calls both read `status='validated'` before either committed; `ex-1200v` v2 was written with `failure_modes: []`. Fixed with a row lock, reproduced with the lock removed. **Open: does the console fire apply twice on a double-click?** | — | — |
| — | **Rule added to `CLAUDE.md`.** Any endpoint that mutates an import batch takes the batch row lock; anything documented as idempotent gets a concurrent-call test. Reasoning recorded with the QIMP4/QIMP5 history. | — | — |
| **QIMP5** | **The sensor catalog.** Split `sensor_not_found` from `sensor_ambiguous`. `sensor.slug` NOT NULL unique, backfilled with collision suffixing; resolution slug-exact → name-fallback. Identical global rows dedupe silently, conflicting ones error. `proposedSensors` + `proposedCategories` in the diff, create-on-approval in one call, re-validate **without re-upload**, apply refused while proposals are outstanding. `catalog_import_batch.sensor_decisions` records who approved what. | **In progress** — built and green, **not committed**. test:db 192→214, suite 923→945 | `1758060000000-SensorSlugAndApprovals` |
| — | **Decision: the apply gate is unconditional.** `acknowledgeWarnings` means "I accept an incomplete class", not "I accept a missing referent". The escape hatch is dismiss → `incomplete_class` → `acknowledgeWarnings` — two recorded acts. | — | — |
| — | **Decision: `catalog.write` covers approval.** Accepting content a workbook proposed is the same category of act QIMP2 already gated. `device-catalog.write` still gates direct, workbook-independent sensor authoring. | — | — |
| — | **Finding: a second race, found by writing the test.** Two concurrent approvals on one batch: the second threw once the first committed, contradicting the documented idempotency. Fixed by falling back to `sensorDecisions`. **That is two concurrency bugs in this subsystem** — QIMP4's apply and QIMP5's approval. Standing rule for `CLAUDE.md`: any endpoint that mutates a batch takes the batch row lock. | — | — |
| — | **Answered: no base seed exists.** A fresh database ships an empty sensor catalog by design; `seed-demo-fleet.ts` is demo-only. The template's example `sensor_capability` row is real importable content and stays. It was harmless while unresolved rows were skipped; the unconditional gate is what made it a stop — which is the correct first-use experience. | — | — |
| **QCAT2** | **Retire vs delete** on sensor capabilities. Retire always allowed, keeps existing references working, removes it from pickers. Delete only when nothing references it. | Not started | — |
| **QCE3** | **Named formula catalogue** (D33) — backend registry of physics formulas declaring inputs by role, unit and kind; Excel `formula` sheet gains select-and-bind mode alongside expression mode; compiler vocabulary gains `#named_formula` | Not started | QCE1.1 |
| **QALERT1** | **Explicit alert evaluation** (D34) — `lookback_readings` (default 10) and reduction by bound direction on the alert rule; plain-English render-back; closes the parked dwell gap | Not started | — |
| **QCE2** | Runtime evaluator — execute `compiled_plan` over a time window, aggregation boundaries, null and gap handling | Not started | QCE1, QCE3 |
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
| **Q08S s3** | Telemetry freshness — `stale_after_seconds` per requirement, separating `no_readings` from `stale`. **Template change split out**: the mechanism ships now with a 900 s platform default; the workbook column lands with QREC0 in one v4 bump. | **Not started** — prompt issued 2026-09-28, no branch on the remote | — |
| **QREC0** | **Library content structure** — KPI definitions, forecast declarations, workflow templates, failure modes, recommendations, **page layout**, the **site class** (D30 part 3), and **`equipment_class_visual` + per-signal anchors** with assets in object storage (D38). An anchor naming an undeclared signal is refused at publish. Template v4 sheets, **including the KPI presentation columns** (`result_kind`, `display_unit`, target, comparison basis, window, chart type) so authors can set them from Excel — until then compiler refusals 8 and 9 are publish-time only. Copy-on-grant. | Not started | Q08S s3, QCE1 |
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

QCE1 is in progress. On merge: **QPART1** next (independent of QCE1, unblocks three later
tasks), then **Q08S s3 + QREC0** as one template v4 change.
