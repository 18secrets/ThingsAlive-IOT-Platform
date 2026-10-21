**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QREC1 — the five deterministic recommendation steps

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/rec-engine`

**Depends on:** QREC0 (shipped — `equipment_class_failure_mode`, `equipment_class_recommendation`
and their client copies), QPARAM1 (shipped — `tenant_parameter`, `resolveParameters`), and
QML1 (**not on `main`** — see §0.2 and question 1). Migration timestamp assigned immediately
before opening the MR, after the last merge-in; `main`'s newest is `1760100000000-IndustryTypes`.

Decisions this task implements and must not re-derive: **D20** (residual anomaly, three
states), **D21** (the five steps, coverage on every step, "no history to search"), **D22**
(recommendations are library content; gap is a set difference against library rows),
**D23/D31** (no currency without tenant inputs; unset is `not_configured`, never zero),
**D39** (costs are client-owned, no platform read path). Rules: **G04, G07, G09, G11, G13**.

---

## 0. Why

A machine raises an alert. Today the page's `recommendations` widget answers by listing
**every** recommendation the class has, whatever is happening to the machine. That is a
catalogue, not a recommendation.

D21 splits the engine into six steps and makes five of them deterministic: **detect**
what is wrong, **attribute** it to a library failure mode, find **precedent** in this
tenant's own history, compute the **gap** between what is happening and what is already in
hand, and **cost** the response from the client's own rates. The sixth, frame, is QREC2.
Every step here is a lookup, a set operation, a SQL query or arithmetic — no model, no
probability, no learned weight (G07).

The output is one **evidence bundle**: an immutable record of what each step searched, what
it found and what it could not see. QREC2 phrases it; QGEN1 cites its id as provenance
(D27); QEVAL1 replays against it. If the bundle can say something the evidence does not
support, everything built on it inherits the defect — so the bundle is the product of this
task, and the endpoint is just how it is read.

### 0.1 What already exists, verified on `main` (`b88856d`)

- `src/catalog/services/recommendation.service.ts` is **not** this. It is P1-10's scenario
  readiness — which scenarios a machine *could* run and what blocks the rest, in
  `availableNow` / `availableLater` / `notApplicable` buckets (retired as display vocabulary
  by D07, still served). It recommends scenarios to activate, not actions on a fault. **Leave
  it alone.** QREC1 is a separate module; reusing the class name would put two unrelated
  meanings behind one word. Name the new module `src/rec-engine/` and its service
  `RecEngineService` (question 9 if you think otherwise).
- Library content: `client_equipment_class_failure_mode` (`code`, `name`, `symptom`,
  `severity` nullable per D32, `signals[]`, `orphaned_at`) and
  `client_equipment_class_recommendation` (`failure_mode_code`, `action`, `urgency` in
  `immediate | next_shift | next_service | monitor`, `estimated_hours` nullable,
  `required_parts` jsonb, unpriced, `orphaned_at`). **Read the client copies, never the
  platform rows** — same reasoning as `RecommendationService`'s header: after grant the
  template stopped being authoritative.
- `src/page/page.service.ts` `failureModeStatus()` already computes `active | unknown |
  clear` from open-alert signals. That is the seed of Attribute. Extract it to one place both
  callers use; do not write a second one.
- Parameters: `src/parameters/parameter-catalog.ts` declares `currency`, `fuel_price`,
  `labour_rate_per_hour`, `operating_cost_per_hour` as cost-typed. Resolution is
  `resolveParameters(m, tenantId, chainForEquipment(profile), names, at)` — equipment →
  equipment class → site → client, per field, with `source` on every answer.
  **There is no `downtime_cost_per_hour` and no `parts_cost`.** D23 names both; QPARAM1 did
  not ship them. See §6 and questions 4–6.
- `work_order` carries `alert_id`, `prediction_id`, `raised_for_scenario`, `started_at`,
  `ended_at`, `status` — **no failure-mode link**. `equipment_service_record` carries `kind`
  (`scheduled | unscheduled | overhaul | meter-replaced`), `work_order_id`, `notes`.
  `alert_event` carries `rule_id`, `state`, `fired_at`, `evidence` jsonb; a rule's signal is
  `ruleSignal(rule)` in `src/page/page.service.ts`.
- Causal chains (`src/intelligence`) emit `chain-origin` alerts whose evidence names the
  origin stage and its residual.

### 0.2 What does not exist yet

- **QML1 is not on `main`.** There is no forecast, no residual band and no model registry.
  `forecast_chart` returns `not_available` / `no_forecast_model`. Detect's residual source
  therefore has nothing to read today.
- **The incident entity is on `main`** (merged 2026-10-14, MR !112): `incident`, `incident_alert`,
  `incident_event`, `incident_sla_policy`, migration `1760200000000-IncidentEntity`, beside the
  phase-1 view in `src/incident/incident.service.ts`. See question 2.

---

## 1. The bundle

```sql
rec_evidence_bundle (
  id                    uuid PRIMARY KEY,
  tenant_id             text NOT NULL,
  source_system         text NOT NULL,
  external_id           text NOT NULL,
  incident_id           uuid,                 -- question 2; NULL when there is no live incident
  as_of                 timestamptz NOT NULL, -- the instant every step read at
  engine_version        text NOT NULL,        -- a code constant; bumps when any step's logic changes
  class_slug            text,                 -- NULL when unclassified (the bundle still exists, see §7)
  class_template_version integer,
  inputs_hash           text NOT NULL,        -- sha256 over the canonicalised inputs, §1.2
  status                text NOT NULL,        -- §7
  reason                text,                 -- §7; NULL only when status = 'ready'
  outcome               text,                 -- §7; NULL unless status = 'ready'
  detect                jsonb NOT NULL,
  attribute             jsonb NOT NULL,
  precedent             jsonb NOT NULL,
  gap                   jsonb NOT NULL,
  cost                  jsonb NOT NULL,
  candidates            jsonb NOT NULL,       -- §3.3, ordered; may be []
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, external_id, inputs_hash, engine_version)
)
```

### 1.1 Rules the database enforces, not the service

- **Append-only.** A trigger refuses `UPDATE` and `DELETE` (G13: evidence is immutable).
  QGEN1 will cite a bundle id as provenance; a bundle that can change after it was cited
  makes that citation a lie. Grant the role `INSERT, SELECT` only, and keep the trigger —
  the grant alone does not survive someone widening it.
- `status` and `reason` are `CHECK`ed against the closed sets in §7, and
  `CHECK ((status = 'ready') = (reason IS NULL))`, and
  `CHECK ((status = 'ready') = (outcome IS NOT NULL))`.
- RLS: `tenant_isolation`, `FORCE`d, like every tenant table. `test/rls-coverage.spec.ts`
  fails until it is.
- If the incident entity has merged when you start: `incident_id` references `incident(id)`.
  If it has not, the column exists, nullable, with no foreign key, and the report says so.

### 1.2 What `inputs_hash` covers, and why it exists

Same machine, same open alerts, same library rows, same parameter values, same history →
same bundle. Hash the canonical JSON (sorted keys) of: the ids and states of the alert
events Detect read, the residual-state rows it read (when QML1 exists), the client failure
mode and recommendation rows (id + `updated_at`), the resolved parameter values with their
sources, and the id + `updated_at` of every precedent row counted. **Not** `as_of` — two
requests a second apart over unchanged data are the same evidence.

This is what makes evaluation idempotent (§8) and what stops a page refresh writing a new
bundle every time it is opened.

---

## 2. Detect — what is wrong (D21: thresholds + TTM residual)

Per signal named by any of the class's client failure modes, one entry:

```ts
{ signal, state, sources: DetectSource[], readiness, reason?, lastReadingAt }
// state: 'anomalous' | 'normal' | 'baseline_not_established' | 'not_observed'
```

**Two sources, both read, never computed here:**

1. **Open alert events on this machine** (`open`, `acknowledged`) — signal from
   `ruleSignal(rule)`. Every trigger kind counts: `signal-threshold` (M-of-N, D34),
   `fuel-loss`, `chain-origin`, `no-telemetry`. Each is an evidence ref
   `alert_event:<id>`. A `no-telemetry` alert makes that signal `not_observed`, not
   `anomalous` — a silent sensor is a coverage fact, not a fault in the machine.
2. **The QML1 residual state** for every signal the class declares `forecast_enabled`. Three
   states per D20; `baseline_not_established` **is carried through as its own state, never
   folded into `normal`.** Until QML1 merges, this source reports
   `readiness: 'not_available', reason: 'no_forecast_model'` for every forecast-declared
   signal — the same answer the `forecast_chart` widget already gives (question 1).

**Freshness decides `not_observed`.** A signal that is unbound, or stale under Q08S s3's
`classifyFreshness`, is `not_observed` with `unbound` / `stale` / `no_readings` as the
reason — **never `normal`**. A dead sensor with no alert is not a healthy sensor (G04).

`detect.coverage`: signals expected, signals observed, signals not observed (named), and
which sources were available. Required by D21 on every step.

## 3. Attribute — which failure mode (D21: library lookup, `failure_mode → signals`)

For each client failure mode on the machine's class:

```ts
{ failureModeCode, name, severity, orphaned: boolean,
  matchedSignals: string[],     // anomalous signals this mode names
  unobservedSignals: string[],  // signals this mode names that Detect could not see
  status: 'active' | 'unknown' | 'clear' }
```

- `active` — at least one named signal is `anomalous`.
- `unknown` — none is anomalous, but at least one is `not_observed` or
  `baseline_not_established`. **"We could not see" is not "clear".**
- `clear` — every named signal observed and `normal`.

`failureModeStatus()` already encodes `active | unknown | clear` for the page; extract it
and make both the page and this step call the one function.

### 3.1 No ranking by likelihood

Several modes can be `active` at once. **There is no probability, score or confidence on
this list** (G07; the calculation-result contract fixes `failure_probability` to `null` for
the same reason). The order is a sort, stated in the response so nobody reads it as a
likelihood:

1. `status` (`active` before `unknown` before `clear`)
2. count of `matchedSignals`, descending
3. declared `severity` by `SEVERITY_ORDER`, NULL last (D32: NULL means nobody declared one)
4. `code`, ascending — so the order is total and a replay is byte-identical

### 3.2 Unattributed

Anomalous signals that no failure mode names go in `attribute.unattributed`. They are the
input to D22's drafting path, which is **not** this task — report them, do nothing else.

### 3.3 Candidates

For each `active` mode in order, its client recommendations, ordered by `urgency` in the
entity's declared order (`immediate`, `next_shift`, `next_service`, `monitor`), then `action`.
`candidates` is that flattened, ordered list with ids. **QREC1 does not select.** D36's
"selected library recommendation" is QREC2's input and its rule is QREC2's question.

## 4. Precedent — has this happened here before (D21: SQL, no model)

For each `active` mode, query this tenant's own rows — never another tenant's, never a
platform aggregate (D39):

| Source | Matches when |
|---|---|
| `alert_event` | same machine, a rule whose signal is in the mode's `signals`, any state |
| `work_order` | same machine, `alert_id` pointing at one of those alert events |
| `equipment_service_record` | same machine, `work_order_id` pointing at one of those work orders |

Report counts, the ids, and for closed work orders the observed `ended_at − started_at`.
**Do not substitute an observed duration for the library's `estimated_hours` in §6** — they
answer different questions, and the response shows both.

The link from a work order to a failure mode is **by signal, through the alert**, because
`work_order` has no failure-mode column. State that in `precedent.method`. A work order
raised by hand with no alert is invisible to this step, and the coverage says so.

### 4.1 Absence is not evidence (D21, verbatim intent)

Three states per mode, never two:

| state | meaning |
|---|---|
| `found` | history exists and matching rows were found |
| `none_found` | history exists for this machine and nothing matched |
| `no_history` | **this machine has no alert events, no work orders and no service records at all** |

`no_history` renders as "no history to search", never as "no similar cases". The first is a
statement about the platform; the second is a claim about the machine.

`precedent.coverage`: the earliest and latest row searched per source, row counts per source,
and the period. **The search period is all history the tenant holds for this machine** — no
lookback window is invented here (question 7).

Whether precedent extends to **other machines of the same class in this tenant** is a product
question (question 8). Until answered: same machine only.

## 5. Gap — what is happening versus what is in hand (D21: set difference)

Three set differences, each deterministic and each named in the response:

1. **`no_library_recommendation`** — `active` failure modes minus those with at least one
   client recommendation. The library has nothing to say; D22's drafting path will care.
2. **`already_in_hand`** — for each candidate, open work orders (`created`, `in-progress`)
   linked through `alert_id` to an alert on that mode's signals. A candidate with one is
   marked `inHand: true` with the work order ids; it is **not removed** from the list.
   Hiding it would leave a manager unable to see the system knew.
3. **`unobserved`** — per active or unknown mode, `unobservedSignals`. The machine cannot
   confirm or rule this mode out until those are bound and fresh.

Whether a tenant can **disable** a recommendation (D39 lists "which recommendations are
enabled" as client configuration) has no column on `main`. Not in this task — question 10.

## 6. Cost — arithmetic over the client's own parameters (D21, D23, D31)

Each cost line is a **CalculationResultV1** (`docs/ai/contracts/calculation-result.v1.schema.json`),
validated against the schema in a test: `definition_version` names the line
(`rec-cost.labour@1`), `context: 'live'`, `estimate_kind: 'library_estimate'`,
`failure_probability: null`, `parameter_set_version` the resolved parameter's
`source.scope:scopeRef@effectiveFrom`, `evidence_refs` naming the recommendation row and the
parameter row. `value` is `null` whenever `status` is not `ready`. `equipment_id` is the
machine's `equipment_profile.id`; `window` is `{ start: as_of, end: as_of }`, because a cost
estimate is read at an instant, not over a period; `computed_at` is `as_of`. If any of these
does not fit the schema as written, stop and report rather than widening the contract.

**One line is defined by what is decided today:**

| Line | Arithmetic | Inputs |
|---|---|---|
| **labour** | `estimated_hours × labour_rate_per_hour` | the client recommendation; `labour_rate_per_hour` resolved for this machine; `currency` |

Refusals, each `value: null`:

| Condition | status | reasons | `limitations` says |
|---|---|---|---|
| `estimated_hours` NULL on the recommendation | `blocked` | `validation_required` | the recommendation id: the library did not author an estimate |
| `labour_rate_per_hour` not set at any scope | `blocked` | `parameters_required` | `labour_rate_per_hour` not set |
| `currency` not set at client scope | `blocked` | `parameters_required` | `currency` not set |

The contract has `additionalProperties: false`, so the missing parameter is named in
`limitations` (and in the bundle's own `cost.missingParameters`), not in a new field.

**Never 0, never a placeholder rate, never a platform default** (D31, D39). With no rates the
consequence is still expressed in **hours and events** (D23): `estimated_hours` and the
precedent counts are always returned, whatever the cost lines say.

**Not computed, and why — each needs a fact nobody has decided:**

- **Downtime cost.** Needs downtime hours and a downtime cost per hour. `estimated_hours` is
  labour time, not machine-down time, and `operating_cost_per_hour` is "cost of running the
  machine for one hour" — not the cost of it standing. Treating either as the other would be
  an invented equivalence (questions 4, 5).
- **Parts.** `required_parts` is unpriced and no `parts_cost` parameter exists (question 6).
- **Fuel.** `fuel_price` exists, but no failure mode declares a fuel consequence to multiply
  it by (question 5).

Return these as named lines with `status: 'pending'`, `reasons: ['parameters_required']` and
a limitation saying what is undecided, so the response shape does not change when they land.

---

## 7. Readiness of the bundle — absence is a state, never an empty list

| Condition | status | reason |
|---|---|---|
| machine has no class | `not_configured` | `unclassified` |
| class not in the account | `not_configured` | `class_not_in_account` |
| class copy has no failure modes | `not_configured` | `no_library_content` |
| no failure-mode signal is observed at all | `blocked` | `insufficient_coverage` |
| nothing `active`, at least one mode `unknown` | `ready` with `outcome: 'inconclusive'` | — |
| nothing `active`, every mode `clear` | `ready` with `outcome: 'nothing_detected'` | — |
| at least one mode `active` | `ready` with `outcome: 'attributed'` | — |
| anomalous signals, none attributed | `ready` with `outcome: 'unattributed'` | — |

`nothing_detected` is only reachable when every named signal was observed. A machine whose
sensors are dead does not get a clean bill of health.

Every refused bundle still carries every step's `coverage`, so the UI can say *why*.

## 8. Endpoints

```
POST /api/v1/equipment/:sourceSystem/:externalId/rec-evidence      -- evaluate now; idempotent
GET  /api/v1/equipment/:sourceSystem/:externalId/rec-evidence      -- latest bundle, or 404 if none
GET  /api/v1/rec-evidence/:id                                      -- one bundle by id
```

- **POST is idempotent by `inputs_hash`**: `INSERT ... ON CONFLICT (tenant_id, source_system,
  external_id, inputs_hash, engine_version) DO NOTHING`, then read the row. Two identical
  calls return the same id, and one row exists. Returns `201` on insert, `200` on hit.
- Capability: `prediction.read` on all three, the same gate as alerts and incidents. A POST
  that only writes a derived, immutable evidence row changes nothing operational — question 3
  if that is wrong.
- Machine visibility: the caller's scope narrows exactly as `AlertService.listEvents` does. A
  machine outside scope is `404`, not `403` — the same answer as any other equipment route.
  **Reuse the existing narrowing; add no scope rule of its own.**
- Swagger on all three, with an example of each `outcome` and of a refused bundle.

### 8.1 The page widget

`recommendations` in `src/page/page.service.ts` currently lists every client recommendation
for the class. Change it to read the latest bundle for the machine and return `candidates`
with `inHand` and the labour line. With no bundle: `not_available` / `not_evaluated`
(**a new reason**; add it to the closed `Reason` set in `src/kpi/types.ts` and to whatever
test holds that set closed). This is the one file outside `src/rec-engine/` this task
changes, besides the extraction in §3; the widget's contract with the UI otherwise stays.

Whether opening the page should **trigger** an evaluation is question 11. Until answered, it
does not: the page reads, it never writes.

## 9. Out of scope

- **Frame** — sentences, templates, any language model. QREC2.
- **Selecting** one recommendation. QREC1 orders candidates; QREC2 selects.
- **Accepting** a recommendation and turning it into work (G11). That needs exact approval,
  idempotency and a work-order link to the bundle; it is its own task (question 12).
- **Drafting** library entries for unattributed patterns (D22's draft path, QGEN1).
- Automatic evaluation on alert fire or incident open (question 11).
- Disabling recommendations per tenant (question 10).
- Adding parameters to the closed catalogue. Downtime, parts and fuel lines wait on
  questions 4–6.
- `src/catalog/services/recommendation.service.ts` and its endpoint.
- Anything under `frontend/`. Report the response shapes the console needs.

## 10. Tests

New spec `test/rec-engine.spec.ts`, added to `test:db`. Seed the state each test changes.

**Detect**
1. An open M-of-N threshold alert on `coolant_temp` → `anomalous`, evidence ref
   `alert_event:<id>`.
2. A bound, fresh signal with no alert → `normal`.
3. A **stale** signal with no alert → `not_observed` / `stale`. **Not `normal`** — assert it
   deliberately; it is the defect this rule exists to prevent.
4. An unbound signal → `not_observed` / `unbound`.
5. A `no-telemetry` alert → `not_observed`, not `anomalous`.
6. A forecast-declared signal before QML1 → source `not_available` / `no_forecast_model`.
   (If QML1 has merged: a signal with fewer than 14 days of residuals →
   `baseline_not_established`, and the mode it belongs to is `unknown`, not `clear`.)

**Attribute**
7. Two active modes, one matching two signals and one matching one → the two-signal mode
   first. Re-run → byte-identical order.
8. Equal match counts, one severity NULL → declared severity first, NULL last.
9. A mode whose only signal is stale → `unknown`, never `clear`.
10. An anomalous signal no mode names → in `unattributed`, nowhere else.
11. An orphaned client mode (`orphaned_at` set) → included, `orphaned: true`.
12. The page's `failure_modes` widget and Attribute agree on status for the same machine —
    read both and assert it. One function, two callers.

**Precedent**
13. A machine with zero alert events, work orders and service records → `no_history` for
    every mode. **Assert the string is not `none_found`.**
14. A machine with history, none on the mode's signals → `none_found`.
15. A closed work order linked through an alert on the mode's signal → `found`, its id and
    observed duration returned, and `estimated_hours` on the candidate unchanged.
16. Another tenant's matching work order → not counted. RLS, attempted, not asserted to exist.

**Gap**
17. An active mode with no client recommendation → in `no_library_recommendation`.
18. An open work order on the mode's alert → candidate `inHand: true`, still listed.

**Cost**
19. `estimated_hours` 3, `labour_rate_per_hour` set at site, overridden at equipment →
    equipment's rate used, `parameter_set_version` names the equipment row, value exact.
20. No `labour_rate_per_hour` at any scope → `value: null`, `blocked`,
    `parameters_required`, `limitations` and `cost.missingParameters` name it. **Not 0.**
21. `estimated_hours` NULL → `blocked`, `validation_required`, names the recommendation.
22. Every cost line validates against `calculation-result.v1.schema.json` — with whatever
    validator question 13 settles. `test/contracts.spec.ts` only inspects the schemas; nothing
    on `main` validates a payload against one.
23. A parameter changed after `as_of` (later `effective_from`) → not used; the bundle reads
    at its own instant.

**Bundle**
24. Unclassified machine → `not_configured` / `unclassified`, every step's coverage present.
25. Every named signal dead → `blocked` / `insufficient_coverage`, **not** `nothing_detected`.
26. **Idempotency, concurrent:** two POSTs over unchanged data fired together
    (`Promise.allSettled`) → both fulfilled, same id, exactly one row.
27. A new alert between two POSTs → two rows, different ids.
28. **Append-only, attempted:** `UPDATE rec_evidence_bundle SET status = ...` as `ta_app` →
    refused by the database. Same for `DELETE`.
29. A `status` outside the closed set, inserted directly → refused by the CHECK.
30. A caller whose scope excludes the machine → `404` on all three routes.
31. RLS: tenant B cannot read tenant A's bundle by id.
32. The `recommendations` widget with no bundle → `not_available` / `not_evaluated`; with
    one → that bundle's candidates.
33. **Migration down path**, named: revert `<timestamp>-RecEvidenceBundle` by name (not
    `undoLastMigration()`), assert the table and trigger are gone, re-run up. Seed a bundle
    first, so the down path is tested against a real row.

## 11. Done when

- `npm run build` clean, `npm run lint` clean, `npm test` and `npm run test:db` green.
  Counts before and after on a worktree off `origin/main`, naming the base SHA. The delta
  is this spec's test count.
- Migration timestamp assigned immediately before the MR, after the last merge-in;
  `verify:migrations` clean; chain from empty; down path named.
- Report: commit SHA, test counts with base SHA; whether QML1 and the incident entity had
  merged when you started and what you did about each; **the bundle for one seeded demo
  machine with an open alert, in full**; the bundle for one with no history; which demo
  classes have failure modes with no recommendations and recommendations with no
  `estimated_hours`; every assumption made.

**One line for the task doc:** five deterministic steps that each say what they searched and
what they could not see — because a recommendation engine that reports "no similar cases" on
a machine with no history is wrong in the most convincing way available.

---

## 12. Questions — answer before starting

1. **QML1 is not on `main`.** The register lists it as a dependency. Ship QREC1 now with the
   residual source reporting `not_available` / `no_forecast_model`, or wait?
   *Recommendation:* ship now. Thresholds are half of Detect and all of today's alerts; the
   residual source is an input slot that fills when QML1 lands, and `forecast_chart` already
   sets the precedent for saying so.
2. **The incident entity is merged (!112).** Should a bundle belong
   to an incident (one evidence bundle per condition episode, as START-HERE's dedupe rule
   suggests), or to a machine at an instant?
   *Recommendation:* to a machine at an instant, with a nullable `incident_id` that is set
   when a live incident exists, with the foreign key to `incident`.
3. **Who may POST an evaluation?** `prediction.read` includes viewers in some tenants.
   *Recommendation:* `prediction.read` — the write is a derived, immutable cache of reads and
   changes nothing a viewer could not already see. If you want viewers strictly write-free
   (G03), use `action.work` for POST and keep GET on `prediction.read`.
4. **Downtime cost.** D23 needs "cost-per-hour of unplanned downtime". QPARAM1 shipped
   `operating_cost_per_hour` instead. Are they the same number to a customer?
   *Recommendation:* no — add `downtime_cost_per_hour` to the closed catalogue in a follow-up
   and leave the line `pending` here.
5. **Downtime hours and fuel consequence.** Is `estimated_hours` labour time or machine-down
   time? Does any failure mode carry a fuel consequence?
   *Recommendation:* treat `estimated_hours` as labour only; add an authored
   `estimated_downtime_hours` to the library recommendation (template v5) if downtime cost is
   wanted. No fuel line until a failure mode can declare one.
6. **Parts.** `required_parts` is unpriced jsonb and there is no `parts_cost` parameter.
   *Recommendation:* show parts as a list, unpriced, in QREC1; pricing parts is its own task
   because it needs a per-tenant price list, not one scalar.
7. **Precedent window.** D21 requires the period searched to be reported, not chosen.
   *Recommendation:* all history the tenant holds for the machine. Revisit if the query is
   slow on the demo tenant — report its cost.
8. **Precedent scope.** Same machine only, or every machine of the same class in the tenant?
   *Recommendation:* same machine in QREC1, with fleet precedent as a separate, labelled
   section later; mixing them would make "found" mean two different things.
9. **Module and route name.** `rec-engine` / `rec-evidence` avoids colliding with the existing
   scenario `RecommendationService`. *Recommendation:* keep; rename the old one only if it is
   ever touched for another reason.
10. **Per-tenant enable/disable of recommendations** (D39 names it as client configuration).
    No column exists. *Recommendation:* a follow-up task adding `enabled` to the client copy;
    QREC1 treats every non-orphaned copy as a candidate.
11. **When is a bundle computed?** On request only, or also when an alert fires / an incident
    opens (via the `domain_event` outbox, D11)? *Recommendation:* on request only in QREC1;
    D40's priority rule ("machines with active alerts first") is the right shape for an
    automatic pass later.
12. **Acceptance → work (G11).** Which task turns an accepted candidate into a work order with
    `rec_evidence_bundle_id` on it? *Recommendation:* a separate task after QREC2, with its own
    concurrency test — a double-click must not raise two jobs.
13. **A JSON Schema validator.** No runtime validator is on `main` (`ajv` is not a declared
    dependency; `test/contracts.spec.ts` reads the schema files, it does not validate
    payloads). CLAUDE.md forbids adding one without naming it. *Recommendation:* approve
    `ajv` (with `ajv-formats` for `uuid` / `date-time`) as a **devDependency**, by name, for
    tests only. QREC2 asks separately whether it becomes a runtime dependency.
