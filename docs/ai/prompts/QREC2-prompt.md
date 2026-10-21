**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QREC2 — Frame: deterministic sentences over the evidence bundle

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/rec-frame`

**Depends on:** QREC1 (the evidence bundle, `rec_evidence_bundle`, and its ordered
`candidates`). **If QREC1 has not merged, stop and report — do not build against a guessed
bundle shape.** QEMB1 is listed as a dependency in the register; it is **blocked** on a
pgvector image on Railway (REPO_MAP, P1-142), and this task ships without it — §7 says
exactly what that costs. Migration timestamp assigned immediately before the MR, after the
last merge-in.

Decisions this task implements and must not re-derive: **D21** (frame is the only model
role; proposer and critic; absence is not evidence), **D22** (select from published library
content — a closed set), **D26** (no numeric value about the future originates from a
language model), **D27** (provenance on everything generated), **D36** (deterministic
renderer first; the model behind a flag, off by default, same contract; phase 1 ships either
way). Rules: **G07, G09, G11**.

---

## 0. Why

QREC1 produces an evidence bundle: structured, complete, and unreadable to a site manager.
Someone has to say it in sentences.

D21 gave that job to a language model. QSPIKE1 then could not get one to complete a single
inference on Railway (D35), and D36 drew the conclusion: the model's remaining job —
phrasing an already-decided selection from an already-gathered bundle — is fluency, not
capability. **So the renderer is templates.** Zero cost, zero latency, and no step in which
an unsupported claim could be invented, because nothing is generated.

The model stays possible, behind a flag, producing the **same contract** from the **same
input**, and checked by the **same code**. It buys better prose and nothing else. When it is
off — which is the default and may be forever — nothing is missing.

### 0.1 What exists, and what does not, verified on `main` (`b88856d`)

- `docs/ai/contracts/grounded-answer.v1.schema.json` — the output contract. It fits: §1 maps
  every field. It has `additionalProperties: false` throughout; **do not widen it**.
  `test/contracts.spec.ts` guards it against loosening.
- `retrieval-hit.v1.schema.json` — what `citations` holds. Nothing on `main` produces one:
  the knowledge, retrieval and context modules are **absent** (REPO_MAP).
- `equipment-context.v1.schema.json` — what `context_id` refers to. **Nothing produces an
  EquipmentContextV1 either** (question 1).
- No `llm_provider_config` table (D08 names it; it was never built), no model client, no
  language-model dependency, no pgvector, no `embedding_profile`.
- Feature flags in this repository are environment booleans read at boot —
  `SHIFT_RUNNER_ENABLED`, `TELEMETRY_PARTITION_MAINTENANCE_ENABLED`. Follow that pattern;
  there is no flag service and this task does not add one.
- No runtime JSON Schema validator. QREC1 question 13 settles `ajv` for tests; whether it
  becomes a runtime dependency here is question 7.

---

## 1. The contract — GroundedAnswerV1, field by field

One frame per bundle per renderer. Every field derives from the bundle; nothing is looked up
afresh, because the frame must describe the evidence the bundle recorded, not whatever is
true by the time someone reads it.

| Field | From |
|---|---|
| `answer_id` | the `rec_frame` row id (§5) |
| `context_id` | the bundle id — question 1 |
| `status` | the mapping in §1.1 |
| `summary` | one template sentence, §3 |
| `observations` | one per anomalous or not-observed signal (Detect), one per precedent result, one per **ready** cost line |
| `hypotheses` | one per `active` failure mode — *"consistent with"*, never *"caused by"* |
| `next_steps` | the selection, §2 |
| `citations` | `[]` until §7 changes it |
| `missing_inputs` | every parameter a cost line was blocked on; every unbound signal a mode names |
| `as_of` | the bundle's `as_of` |
| `limitations` | every coverage gap QREC1 recorded, phrased (§3.2) |
| `proposal_ids` | omitted — QGEN1 does not exist |

**Evidence refs** use one grammar, and the validator (§4) resolves every one:
`alert_event:<uuid>`, `work_order:<uuid>`, `equipment_service_record:<uuid>`,
`client_equipment_class_recommendation:<uuid>`, `tenant_parameter:<uuid>`, or
`rec_evidence_bundle:<uuid>#<json-pointer>` for a fact the bundle itself carries (a coverage
count, a `no_history` state). `observations[].evidence_refs` has `minItems: 1`: an
observation with nothing to point at is not an observation.

**Hypotheses carry limitations, always.** The schema's own description: *a suspected cause is
not a confirmed diagnosis.* Each active mode's `limitations` lists its `unobservedSignals`, any
`baseline_not_established` signal, and the sentence that attribution is a library lookup, not
a diagnosis.

### 1.1 Status

| Bundle | `status` |
|---|---|
| `ready`, `outcome: 'attributed'`, every active mode fully observed | `answered` |
| `ready`, `attributed` with unobserved signals, or `inconclusive`, or `unattributed` | `partial` |
| `ready`, `outcome: 'nothing_detected'` | `answered` — and the summary says what was checked |
| `not_configured` (unclassified, class not in account, no library content) | `needs_input` |
| `blocked` / `insufficient_coverage` | `insufficient_evidence` |

A blocked cost line does **not** downgrade `status`: the recommendation stands, the money is
`missing_inputs`. D23 — consequences in hours and events until a rate exists.

`unavailable` is reserved for a frame that could not be rendered at all (§4.3), never for a
bundle that said "I could not see".

## 2. Selection — the closed set (D22)

QREC1 orders `candidates`; it does not choose. D36's "the selected library recommendation" is
chosen here, deterministically, from that list and nothing else:

> **Selected** = the first candidate, in QREC1's order, that is not `inHand`.

`next_steps` is the selected candidate first, then the remaining candidates for the same
failure mode in order, with `inHand` ones included and phrased as already in hand. Candidates
for lower-ordered active modes are not in `next_steps`; they are in the bundle, and the frame
says how many (question 2).

Each next step:

| Field | Value |
|---|---|
| `aim` | the library recommendation's `action`, **verbatim** |
| `expected_outcome` | question 3 — the library has no such field |
| `required_capability` | `action.work` — reported, never granting (the schema's own words) |
| `simulation_available` | `false` — nothing simulates a recommendation yet |

No candidates → `next_steps: []`, and the summary says the library has no recommendation for
what was detected (QREC1's `no_library_recommendation`). **It never says "no action needed".**

## 3. Templates

**Templates are TypeScript, a deploy** — the same rule as widget types and operators. The
vocabulary of sentences is closed; what fills them is the bundle.

- One module, one exported map from a key `(section, state)` to a function of bundle fields
  returning a string. `section` ∈ summary, detect, attribute, precedent, gap, cost, limitation.
  `state` is the closed state set of that section in QREC1.
- **A test asserts every `(section, state)` the bundle can produce has a template** — the same
  shape as "every compiler operator has an executor". A new state in QREC1 without a template
  fails the suite rather than rendering nothing.
- `TEMPLATE_VERSION` constant, recorded on every frame. A wording change bumps it.
- English only (question 5). Signal and failure-mode names come from the client copy, units
  from the binding, currency code from the resolved `currency` parameter.
- **Every number in a sentence is formatted from a bundle value by one formatter.** No
  template may contain a numeric literal of its own. §4 enforces this, so a template that
  hard-codes "6 of 10" fails at render.

### 3.1 Shapes — placeholders, not values

Illustrative only. Every `{…}` is a bundle field; none of these numbers exists until the
bundle supplies it.

- Detect, threshold alert: *"{signal}: {m} of the last {n} readings were above {bound} {unit}
  (alert raised {firedAt})."* — the D34 render-back, read from the alert's evidence.
- Detect, not observed: *"{signal} has not reported since {lastReadingAt}; it cannot confirm
  or rule out anything."*
- Attribute: *"The pattern is consistent with {failureMode}, which the {class} library links
  to {matchedSignals}."*
- Precedent `found`: *"{count} earlier alerts on {signals} on this machine, {closedCount} closed
  by work orders taking {durations}."*
- Precedent `none_found`: *"No earlier alerts on {signals} in this machine's history since
  {earliest}."*
- Precedent `no_history`: *"No history to search — this machine has no recorded alerts, work
  orders or service records yet."*
- Cost ready: *"Labour: {hours} h at {rate} {currency}/h, {value} {currency} (rate set for this
  {scope})."*
- Cost blocked: *"Labour cost not shown: no labour rate is set for this machine."*

### 3.2 Absence sentences are their own templates

`no_history`, `not_observed`, `baseline_not_established`, `no_forecast_model`,
`parameters_required` and `nothing_detected` each have a template of their own. **None of
them may share wording with a positive result.** "No similar cases" for `no_history` is the
defect D21 names; a template test asserts the two strings differ and that the `no_history`
string contains neither "similar" nor "occurred".

`nothing_detected` names what was checked: *"{observed} of {expected} signals reporting; none
outside its limits."* — never "machine healthy".

## 4. The validator — the critic, in code

D21's critic strikes every claim the bundle does not support. Under D36 the critic is code,
and it runs on **every** frame, whichever renderer produced it. Two paths, one gate.

### 4.1 Checks

1. **Shape.** The frame is a valid GroundedAnswerV1 (question 7 for how).
2. **Refs resolve.** Every `evidence_refs` entry parses under §1's grammar and resolves to the
   bundle or to a row id the bundle names. A ref to a row the bundle did not read is refused
   even if the row exists — the frame describes the bundle, not the database.
3. **Numbers trace.** Every numeric token in every string field appears, after the one
   formatter's normalisation, among the bundle's values. This is D26's test made mechanical:
   *the test is provenance, not format.* Dates and times included.
4. **No future-tense number.** Until QML1 provides a forecast with a run id, horizon and
   interval, the bundle holds no forecast values, so check 3 already refuses any. When QML1
   lands, a future value must carry its forecast run ref; the check is written now so it is
   not forgotten then.
5. **Closed set.** Every `next_steps[].aim` equals, character for character, a candidate
   `action` in this bundle. A paraphrased action is refused: the library wording is what a
   technician was trained on.
6. **No probability.** No string contains a percentage or likelihood word the bundle does not
   carry (`%`, "likely", "probability", "chance", "confidence"). G07; the bundle has none to
   carry.

### 4.2 On the template path

A failure is a **bug in a template**, and it is a `500` with the failing check named — never
a frame served with the claim struck. The test suite should make this unreachable.

### 4.3 On the model path

Any failed check discards the **whole** model frame; the template frame is served, and the
refusal is recorded on the `rec_frame` row the model attempt wrote (§5) with every failed
check named. Question 6 asks whether to strike-and-keep instead.

## 5. Persistence and provenance (D27)

```sql
rec_frame (
  id                uuid PRIMARY KEY,         -- the answer_id
  tenant_id         text NOT NULL,
  bundle_id         uuid NOT NULL REFERENCES rec_evidence_bundle(id),
  renderer          text NOT NULL,            -- 'template' | 'model'  (CHECK)
  renderer_version  text NOT NULL,            -- TEMPLATE_VERSION, or the model adapter's version
  model_id          text,                     -- NULL for 'template'; required for 'model' (CHECK)
  model_version     text,                     -- likewise
  validation        text NOT NULL,            -- 'passed' | 'refused'  (CHECK)
  refused_checks    text[] NOT NULL DEFAULT '{}',
  answer            jsonb,                    -- NULL when validation = 'refused'
  created_at        timestamptz NOT NULL DEFAULT now()
)
-- a unique INDEX, not a table constraint: a constraint cannot hold an expression
CREATE UNIQUE INDEX uq_rec_frame ON rec_frame
  (bundle_id, renderer, renderer_version, COALESCE(model_id, ''), COALESCE(model_version, ''));
```

- **Append-only**, by trigger as well as grant — QREC1's rule, same reason: QGEN1 and any
  acceptance flow will cite an `answer_id`.
- `CHECK ((validation = 'passed') = (answer IS NOT NULL))`. A refused model frame keeps its
  refusal, never its prose — unvalidated text is not stored where it could be served.
- RLS: `tenant_isolation`, `FORCE`d.
- The template frame is deterministic, so the unique key makes it **one row per bundle per
  template version**, however often it is asked for.

## 6. Endpoints and the flag

```
POST /api/v1/rec-evidence/:bundleId/frame     -- render if absent; idempotent
GET  /api/v1/rec-evidence/:bundleId/frame     -- the served frame, or 404 if never rendered
```

- POST: render with the template renderer and insert with `ON CONFLICT DO NOTHING`, then read.
  If the flag is on (below) and no row exists for this bundle and this model id and version,
  also attempt the model renderer and insert its row — one attempt per model version, not one
  per request. Serve the model frame only if `validation = 'passed'`, otherwise the template
  frame. `201` on insert,
  `200` on hit.
- Response: the GroundedAnswerV1, plus a sibling `provenance` object (`renderer`,
  `rendererVersion`, `modelId`, `modelVersion`, `bundleId`) — beside the answer, not inside
  it, because the contract is closed.
- Capability and machine scope: exactly QREC1's (`prediction.read`, the same narrowing, `404`
  outside scope). A bundle id from another tenant is `404`, not `403`.

### 6.1 The flag

`REC_FRAME_MODEL_ENABLED`, read at boot, **default `false`**.

- **Off:** the model adapter is never constructed and never called. Not "called and ignored".
- **On with no model configured:** boot logs one warning that the model renderer is
  unavailable and every frame is the template frame — the shape of `LegacyDataSource`'s
  warning. A missing model never fails a request.
- **On with a model:** a `FrameModel` interface — `(bundle, templateFrame) → candidate frame`.
  The model may **rephrase** string fields and **select a different candidate from the same
  bundle's `candidates`**. It may not add observations, refs, numbers or next steps. Its input
  includes the template frame, so what it is asked to do is rewrite, not compose.

**This task builds the seam, not the client.** `FrameModel` is an interface with one
implementation in the test suite (a fake). No HTTP client, no provider SDK, no npm
dependency, no provider configuration table — D08's `llm_provider_config` is Master Admin
configuration and is its own task, and QSPIKE1b has not produced a runtime to point it at
(question 8).

## 7. Without QEMB1 — what this ships, and what it does not

QEMB1 provides pgvector and a pinned `bge-small-en-v1.5` embedding profile. It is blocked on
a pgvector-capable Postgres image on Railway. **Nothing in §1–§6 needs it.**

What its absence costs, precisely:

- **`citations` is always `[]`**, and `limitations` says *"No reference documents are
  searchable yet."* A RetrievalHitV1 needs a `document_version_id` and `chunk_id`, and no
  document store exists — QEMB1 alone would provide vectors, not documents. Citations need
  QEMB1 **and** a knowledge corpus with ingestion (REPO_MAP: knowledge and retrieval absent).
- **Nothing else.** Selection is from a closed list (§2), precedent is SQL (QREC1), and the
  templates need no similarity search.

So QREC2 ships without QEMB1, and citations become a follow-up task (QREC2b) that depends on
QEMB1 and the knowledge layer. Question 4 asks whether QEMB1 was meant for something else.

## 8. The page widget

The `recommendations` widget (QREC1 §8.1) returns the latest bundle's candidates. Add the
served frame's `summary`, `next_steps` and `limitations` when a frame exists for that bundle.
With no frame, the widget is unchanged — it does not render one on read. The page reads; it
never writes (question 9).

## 9. Out of scope

- A real language-model client, its provider configuration, its deployment (`llm` service,
  D41) or any runtime spike. The seam only.
- Citations and anything that needs QEMB1 (§7).
- Accepting a recommendation, raising a work order from a next step, auto-create or
  auto-dispatch (G11) — its own task, with exact approval and a concurrency test.
- Drafting candidate library entries for `unattributed` patterns (D22's draft path, QGEN1).
- Translations (question 5).
- Changing the bundle. If a template needs a fact the bundle does not hold, stop and report —
  that is a QREC1 change, not a lookup here.
- Anything under `frontend/`. Report the response shape.

## 10. Tests

New spec `test/rec-frame.spec.ts`, added to `test:db`. Seed the state each test changes.

**Contract**
1. A bundle of every `outcome` and every refused `status` → a frame that validates against
   `grounded-answer.v1.schema.json`, with the `status` §1.1 gives.
2. Every `(section, state)` key the bundle vocabulary can produce has a template. Derived from
   QREC1's exported state sets, not listed by hand.
3. Rendering the same bundle twice → byte-identical `answer`.

**Absence**
4. A `no_history` bundle → the precedent sentence contains "No history to search" and
   contains neither "similar" nor "occurred".
5. A stale signal → its observation says it has not reported; **no string calls it normal**.
6. `nothing_detected` → the summary names how many signals were checked; it does not contain
   "healthy".
7. No labour rate → `missing_inputs` contains `labour_rate_per_hour`; **no currency amount
   appears in any string**; `status` is not downgraded.
8. No candidates → `next_steps: []`, and no string contains "no action".

**Selection**
9. Two candidates, the first `inHand` → the second is selected and first in `next_steps`; the
   first follows, phrased as in hand.
10. Every `aim` equals a library `action` verbatim.

**Validator — attempted, not asserted to exist**
11. A template patched in-test to emit a number not in the bundle → render refused, check 3
    named. Restore it.
12. A ref to a real `alert_event` the bundle did not read → refused, check 2 named.
13. The fake model returns a sentence with a new number → model frame refused, template frame
    served, the `rec_frame` row records `refused` with check 3, `answer` NULL.
14. The fake model returns an `aim` not among the candidates → refused, check 5.
15. The fake model selects a **different valid candidate** and rephrases → accepted and served;
    `provenance.renderer` is `model`, model id and version recorded.
16. The fake model returns "likely" or a percentage → refused, check 6.

**Flag**
17. Flag off, fake model registered → the fake is **never called** (spy count 0).
18. Flag on, no model → template frame, one boot warning.

**Persistence**
19. **Concurrent idempotency:** two POSTs for the same bundle fired together
    (`Promise.allSettled`) → both fulfilled, same `answer_id`, one template row.
20. **Append-only, attempted:** `UPDATE rec_frame` and `DELETE FROM rec_frame` as `ta_app` →
    refused by the database.
21. Inserting `validation = 'refused'` with a non-NULL `answer` → refused by the CHECK.
22. RLS: tenant B cannot read tenant A's frame, by bundle id or by answer id.
23. A caller whose scope excludes the machine → `404`.
24. **Migration down path**, named: revert `<timestamp>-RecFrame` by name, seed a frame first,
    assert the table and trigger are gone, re-run up.

## 11. Done when

- `npm run build` clean, `npm run lint` clean (the encoding check covers every template
  string), `npm test` and `npm run test:db` green. Counts before and after on a worktree off
  `origin/main`, naming the base SHA; the delta is this spec's count.
- Migration timestamp assigned immediately before the MR; `verify:migrations` clean; chain
  from empty; down path named.
- Report: commit SHA, test counts with base SHA; **the rendered frame for each of QREC1's two
  reported demo bundles, in full**; every template key and its sentence, as a table, for
  review by someone who has run a maintenance crew; the answers you acted on from §12; every
  assumption made.

**One line for the task doc:** the frame is templates because the only thing a model would
add is fluency — and a sentence that cannot contain a number the evidence does not hold is
worth more on a maintenance screen than a better-written one that might.

---

## 12. Questions — answer before starting

1. **`context_id`.** The contract expects an EquipmentContextV1 id, and nothing produces one.
   *Recommendation:* use the bundle id, and say so in the Swagger description. The bundle is
   the context this answer was grounded in; building P05's context assembler to fill one
   field is out of proportion. If the context layer is built later, the bundle can carry a
   `context_id` of its own.
2. **How many failure modes go into `next_steps`?** Only the top active mode, or every
   active mode's candidates? *Recommendation:* the top mode only, with the count of others in
   the summary — a list of every action for every possible cause is the catalogue QREC1 was
   built to replace.
3. **`expected_outcome` is required, and the library has no such field.** *Recommendation:*
   in QREC2, a template over library facts only — *"Addresses {failureMode}."* — and add an
   authored `expected_outcome` to the library recommendation in the next template bump. Never
   generate one.
4. **What was QEMB1 meant to contribute to QREC2?** The register makes it a dependency, but
   nothing in D21, D22 or D36 uses similarity search in the frame. *Recommendation:* drop the
   dependency from QREC2 and move it to a QREC2b (citations), which also needs a knowledge
   corpus. If it was meant for fuzzy precedent over work-order notes, that is a QREC1 change
   and a decision of its own — free-text similarity is not "SQL, no model" (D21).
5. **Language.** English only, or a second locale for phase 1? *Recommendation:* English
   only, templates keyed so a locale is a second map rather than a rewrite. Ask the UI team
   before adding one.
6. **On a model frame that fails one check: discard it, or strike the claim and keep the
   rest?** D21 says the critic "strikes". *Recommendation:* discard and fall back. With a
   template frame always available, a struck model frame is strictly worse — model prose with
   a hole in it — and partial striking is a second code path to get wrong.
7. **Runtime schema validation.** Check 1 needs a JSON Schema validator at runtime on the
   model path. *Recommendation:* approve `ajv` and `ajv-formats` as **runtime** dependencies,
   by name. The template path is typed and test-validated; the model path is exactly where a
   structural check must not be a test-only check.
8. **Is a real model client in scope at all?** D36 says the model sits behind the flag. QSPIKE1b
   has no working runtime and D08's provider configuration does not exist. *Recommendation:*
   seam and fake only, as written. A real adapter is a task that starts when QSPIKE1b reports
   a completed inference.
9. **Should opening the machine page render a frame?** *Recommendation:* no. Rendering is a
   POST; the page shows a frame if one exists. If the UI needs one always present, the
   evaluation and render can be chained in one request later — they are deterministic and
   cheap (D35), so that is a latency choice, not a cost one.
10. **Who reviews the sentences?** The report lists every template. *Recommendation:* someone
    who has run a maintenance crew on this equipment, before merge — wording on a fault screen
    is a domain decision (START-HERE: domain review is a human input), not a code one.
