**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QGEN2 — The KPI / formula emitter

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/kpi-emitter`

**Depends on:** QGEN1 (the proposal substrate — **must be merged**), QCE2 (shipped —
`src/kpi/services/kpi-evaluator.service.ts`). **If QGEN1 has not merged, stop and report.**
**Answer §9 first**; questions 1 and 2 decide what this emitter is.

Read, in addition to what `CLAUDE.md` names: `docs/ai/decisions/ai-layer-decisions.md` D25,
D26, D27, D30, D31, D32, D33, D36; `src/catalog/formula/formula-compiler.ts`,
`src/catalog/formula/operator-registry.ts`, `src/catalog/formula/named-formula-binding.ts`;
`src/client-catalog/entities/client-formula.entity.ts` and its migration
`1758080000000-ClientFormula.ts`; `src/database/migrations/1758700000000-UpgradeLabels.ts`;
the QGEN1 emitter interface.

---

## 0. Why

D25's first emitter row:

| Emitter | Emits | Closed vocabulary | What rejects it |
|---|---|---|---|
| **KPI / widget** | a formula expression + presentation metadata | the class's declared signals, and the registered operator set | the QCE1 compiler |

The substrate (QGEN1) already gives a proposal its immutability, provenance, scope routing,
idempotency and approval. This task plugs in the one thing it lacks for KPIs: an emitter that
turns a user's selection into a **client formula proposal** the existing compiler can accept
or refuse.

D25, stated precisely: **nothing the model writes is executed as written; a formula
expression is permitted and is compiled by QCE1 against a closed operator registry. If it
does not compile, it does not publish.** So the worst possible output is a wrong arrangement
of valid parts, never a new capability. That holds only as long as the expression reaches
nothing but the compiler — **never `eval`, never `new Function`, never a template string
executed anywhere**. The compiler is a hand-written parser over a closed registry; this task
adds no second path to execution.

D26 bounds it from the other side: a KPI is **composed**; a future value is **computed**.
This emitter composes formulas over observed signals and parameters. It never emits a number
about the future, and a KPI is not a forecast. **Prediction has no emitter** (D26).

## 1. What a KPI proposal is

D30: a KPI is a formula plus how it is read. The payload is exactly the columns
`client_formula` already has — no new shape:

| Part | Columns | Checked by |
|---|---|---|
| the formula | `formula_key`, `kind`, and **either** `expression` **or** `named_formula_slug` + `named_formula_version` + `bindings` (D33) | QCE1 `compileFormula`; for bind mode, `checkRolesBound`, `checkDimensions`, `checkSuspiciousBindings` |
| how it is read | `result_kind`, `display_unit`, `display_format`, target (`target_value` / `target_min` / `target_max`, `target_direction`), `comparison_basis`, `aggregation_window`, `chart_type` | the compiler for the inference-checked columns (D32); the existing CHECKs for the rest |

- `result_kind` and `display_unit` are **NULL unless the emitter has a reason to declare
  them** — D32: an unsupplied value is not a declaration, and NULL means infer.
- `required_signals`, `required_parameters` and `compiled_plan` are **never in the payload**.
  They are derived by the compiler at materialisation, as for every other formula. An
  emitter that supplied them would be asserting what only the compiler may conclude.
- `@param` references are allowed (D31); a KPI whose parameters are unset materialises and
  renders `not_configured` — never zero, never a placeholder. The proposal says which
  parameters the tenant has not supplied.
- **Target values.** A target is a number a person acts on. Where it comes from is question 3;
  until answered, the emitter leaves targets NULL (`target_direction = 'none'`) and says so.

## 2. The emitter

Registered with QGEN1 as `kind = 'kpi'`. Its seed is a selection from lists — D25: "seeded
by user selection, never given an open request":

```ts
type KpiSeed = {
  target: { sourceSystem: string; externalId: string } | { clientEquipmentClassSlug: string };
  intent: KpiIntent;              // a closed list — question 1
  namedFormulaSlug?: string;      // when the intent is "bind this catalogue formula"
  failureModeCode?: string;       // when the KPI is meant to watch a failure mode's signals
};
```

What the deterministic path does, which is the only path built here (D36 — question 2):

- **Bind a named formula** (D33): pick the catalogue formula the user selected, map each
  role to a class signal whose declared **measurement** matches the role — never by unit
  alone, D33's coolant-vs-ambient warning. A role with no matching signal, or more than one,
  returns `needs_input` naming the role and the candidates; **the emitter does not guess**.
- **D33 and the code disagree here, and the emitter takes the stricter side.** D33 says a
  binding whose measurement does not match the role is refused. `named-formula-binding.ts`
  implements it as a `suspicious_binding` **warning** a person clears with
  `acknowledgeWarnings`, and `RoleInput.expectedParameters` is optional. An emitter cannot
  acknowledge a warning on a person's behalf, so for a generated binding a
  `suspicious_binding` is a refusal. A role with no `expectedParameters` cannot be checked
  for measurement at all — what the emitter does then is question 6. Do not change the
  hand-authoring path's behaviour.
- **Compose from the class's existing formulas** where the intent is a derived ratio over
  them (`#formula_key`), using only formulas already in the tenant's class copy.

`emit` returns either a payload or `needs_input` with what is missing. `needs_input` writes
no proposal — there is nothing to gate. `render` produces the plain-English reading: what
the KPI measures, from which signals and parameters, in which unit, against which target.

**The proposal's `target_versions`** record the class copy's version and the catalogue
formula version read, so QGEN1's approval recheck refuses a proposal whose class moved under
it.

## 3. The gate for a KPI

QGEN1's gate with `kind = 'kpi'`:

1. **Compile** with `compileFormula` against the target class copy's declared signals, the
   tenant's sibling formulas (for `#refs`), the signal-state vocabulary and the declared
   presentation columns. A refusal is `compile_refused` with the compiler's own message.
2. **Replay: `not_applicable`.** A KPI does not fire; D28 gates things that fire. QGEN1's
   CHECK holds this to `kind = 'kpi'`.
3. **Evaluate once, read-only, for information** — run the compiled plan through the QCE2
   evaluator over the target machine's most recent `aggregation_window`, inside a `READ
   ONLY` transaction, and attach the result envelope (value, unit, readiness, reason,
   coverage) to `gate_detail`. This is **not** a pass/fail test and it is never cached into
   anything live. It exists so the approver sees `unbound` or `stale` before approving a KPI
   that will render empty — G04: missing data never looks healthy. A `value` of `null` with
   its reason is shown as such.

## 4. Materialisation

On approval, through the same code path a hand-authored or copied client formula takes —
**not** a direct insert by the substrate:

| Scope | Writes | Approver |
|---|---|---|
| `tenant` | a `client_formula` row in the tenant's class copy, compiled at write | per QGEN1 (super admin) |
| `class` | a **draft** `equipment_class_formula` candidate for master admin | per QGEN1 question 2 — **not built until answered** |

**Tenant scope is class-wide inside the tenant.** `client_formula` is keyed by
`(tenant_id, client_equipment_class_slug, formula_key)`, so a KPI proposed while looking at
one machine applies to every machine of that class the tenant has. D27 describes tenant scope
as "specific to this machine's configuration". That mismatch is question 4; do not add a
per-machine formula table to resolve it.

`client_formula` has no provenance for generated rows today. Add, by a new migration:

```sql
ALTER TABLE client_formula
  ADD COLUMN source text NOT NULL DEFAULT 'copied',   -- CHECK IN ('copied','manual','generated')
  ADD COLUMN proposal_id uuid REFERENCES artifact_proposal;
-- CHECK: source = 'generated' iff proposal_id IS NOT NULL
```

Existing rows backfill to `'copied'` — QGRANT0's copy-on-grant is the only writer on `main`.
**Verify that before writing the default**: if any other writer exists, stop and report
rather than labelling its rows wrongly. A generated row's origin label (QUPGRADE1's computed
`tenant_added`) must come out right with no special case — `template_version` is NULL, so it
already does; test it rather than assume it.

A `formula_key` collision with an existing formula in the class copy is refused at
materialisation (the unique index does it; the service turns it into a 409 naming the key),
never resolved by overwriting. Approval stays idempotent per QGEN1.

## 5. Endpoints and capabilities

| Route | Capability | Does |
|---|---|---|
| `POST /equipment/:sourceSystem/:externalId/kpi-proposals` | `prediction.read` to propose — question 5 | builds the seed from the request's selection, calls `ProposalService.propose('kpi', …)`; returns the proposal or `needs_input` |
| `GET /kpi-proposal-intents` | `prediction.read` | the closed intent list and, per intent, what the user must pick |

Everything else — reading, approving, rejecting — is QGEN1's `/proposals` routes. Do not add
a second approval path.

## 6. Out of scope

- A language-model path. D36: behind a feature flag, off by default, same contract — a
  follow-up once a runtime works (QSPIKE1b). If it is added later it calls the same
  `emit` contract and its output goes through the same compiler.
- Any forecast, predicted value or "expected next week" KPI — D26.
- Class-scope materialisation until QGEN1 question 2 is answered.
- Editing an approved proposal. A changed KPI is a new proposal.
- New operators. The registry is TypeScript and a deploy (D25); an intent that needs an
  operator the registry lacks is reported, not worked around.
- Widget placement on the page (QPAGE1 / layout) — a KPI exists; where it shows is separate.
- Anything under `frontend/`; no new npm dependencies.

## 7. Tests

Refusals attempted, not asserted to exist.

1. Bind `performance_ratio` (or any seeded named formula) on a class whose signals match each
   role by measurement → proposal compiles, `gate_outcome = 'not_applicable'`, materialises a
   `client_formula` whose `compiled_plan` equals what the hand path produces for the same
   bindings.
2. A role matching two signals → `needs_input` naming both; no proposal row written.
3. A role whose only unit-compatible signal measures the wrong thing → refused, not bound
   (D33's coolant-vs-ambient case, by name) — where the hand path would only have warned.
   The same binding through the hand path still warns and still accepts
   `acknowledgeWarnings`: assert both, so the stricter rule cannot leak into it.
4. **The expression never executes outside the compiler:** a payload expression of
   `constructor.constructor('return process')()` and one of `require('fs')` → `compile_refused`
   with the parser's message; assert no side effect (a sentinel global is untouched).
5. A payload naming a signal the class does not declare → `compile_refused`.
6. A payload with `result_kind = 'scalar'` on a series expression → `compile_refused` (D32's
   check, through the emitter path).
7. A payload that tries to carry `required_signals` or `compiled_plan` → refused at the
   payload schema; the stored row's values are the compiler's.
8. `@tariff_per_kwh` unset for the tenant → materialises; the KPI reads `not_configured`,
   value `null`, never 0.
9. The informational evaluation runs read-only: make it attempt a write → PostgreSQL refuses.
   And it writes nothing anywhere a KPI read would see.
10. An unbound signal on the target machine → `gate_detail` carries `unbound`, value `null`;
    approval still possible and the response says the KPI will render empty.
11. `formula_key` already present in the class copy → 409 on approval, existing row untouched.
12. **Concurrent approve** of one KPI proposal via `Promise.allSettled` → both settle, one
    `client_formula` row.
13. Class copy version changed after proposal → approval 409 (QGEN1 recheck, through this
    kind).
14. A generated row reads as `tenant_added` in the class-upgrade plan.
15. `INSERT client_formula` with `source = 'generated'` and no `proposal_id` → the database
    refuses; and the reverse.
16. There is no `prediction` intent and no route that proposes one.
17. RLS: tenant B cannot see or approve tenant A's KPI proposals or the formulas they made.
18. Down path: **`GeneratedClientFormula<timestamp>`'s** down migration, named, drops the two
    columns and leaves seeded copied formulas intact.

**Seed before you migrate** — seed copied `client_formula` rows before the migration that
backfills `source`.

## 8. Done when

- `npm run build && npm run test:db` green; `npm run lint` clean. Counts before and after on
  a worktree off `origin/main`, naming the base SHA.
- Migration timestamp assigned immediately before the MR, after the last merge-in; chain
  clean from empty; down path named.
- Report: commit SHA; files created and changed; test counts with base SHA; the intent list
  as built; which seeded named formulas bind cleanly on which seeded classes and which return
  `needs_input` (and why); how each §9 question was answered; every assumption; anything not
  implemented, with the reason.

**One line for the task doc:** the KPI emitter arranges parts the platform already has —
signals, operators, catalogue formulas, parameters — and the compiler decides whether the
arrangement means anything; nothing it writes runs except through that compiler.

---

## 9. Questions — answer before starting

1. **The intent list.** D25 seeds emitters from "intent picked from lists"; no list exists.
   What may a user ask a KPI for? *Recommendation:* start with two — "bind a catalogue
   formula to this class" and "ratio of two existing KPIs" — and grow the list as a deploy,
   the same rule as operators.
2. **Is a deterministic-only emitter acceptable for QGEN2?** D36 makes the generative layer
   optional and puts a model behind a flag for the renderer; it says nothing explicit about
   emitters. *Recommendation:* yes — ship the deterministic path; a model-backed `emit`
   behind a flag, off by default, is a follow-up gated on QSPIKE1b.
3. **Where a target value comes from.** A target is a number someone acts on; G07 forbids
   fabricated limits. Library KPI default, tenant parameter, user's input in the seed — or
   none, with targets set by a person after approval? *Recommendation:* only from the
   library's own formula target or a value the user typed into the seed; otherwise NULL.
4. **Tenant scope is class-wide.** `client_formula` applies to every machine of the class in
   the tenant, but D27 calls tenant scope "specific to this machine's configuration". Accept
   class-within-tenant as tenant scope for KPIs? *Recommendation:* accept it and record it;
   a per-machine KPI table is a separate decision with its own cost on the page endpoint.
5. **Who may propose.** Proposing writes only a draft; approval is the gate. Is
   `prediction.read` (every client role) enough to propose, or does proposing need its own
   capability? *Recommendation:* `prediction.read` to propose, rate-limited per user per day
   (number from Deepak), with approval held to QGEN1's approver.
6. **Roles with no declared measurement.** `RoleInput.expectedParameters` is optional, so for
   some catalogue formulas the emitter cannot tell coolant from ambient temperature. Bind on
   unit alone and label it, or return `needs_input` and let the user pick the signal?
   *Recommendation:* `needs_input` — the user picking the signal from the unit-compatible
   list is a human binding, which is what D33 assumed; an emitter binding on unit alone is
   the confident wrong number D33 warns about.
