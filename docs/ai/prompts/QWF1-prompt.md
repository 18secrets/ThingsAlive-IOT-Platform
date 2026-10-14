**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QWF1 — Workflow assembly and the alert compiler

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/workflow-compiler`

**Depends on:** QCE2 (shipped — `src/kpi/services/kpi-evaluator.service.ts`), QALERT2
(shipped — M-of-N in `src/alert/services/alert-rules.ts`). **Answer §12 first.** Two of its
questions (the node vocabulary and the composite trigger's shape) change the data model; if
they are unanswered, stop and report rather than picking.

Read, in addition to what `CLAUDE.md` names: `docs/ai/DECISIONS.md` D04, D05, D16;
`docs/ai/decisions/ai-layer-decisions.md` D25, D28, D34; `src/alert/services/alert-rules.ts`,
`src/alert/services/alert.service.ts`, `src/alert/entities/alert-rule.entity.ts`,
`src/alert/alert.controller.ts`, `src/catalog/entities/alert-rule-template.entity.ts`,
`src/shift/services/shift-runner.service.ts` (only `evaluateAlerts`), and
`src/database/migrations/1757960000000-SignalBindings.ts` for voice.

---

## 0. Why

D16 settled the expensive question already: **alert workflows compile to `alert_rule`; only
agent workflows need a new runtime.** `alert_rule` stays the unit the shift runner evaluates.
A workflow is the *authored* layer above it, with a compiler in between — a front end plus a
compiler, not a second engine.

What that buys, and what this task must not lose:

- **No migration of live customer alerts.** Hand-authored and template-copied rules keep
  working untouched. Nothing in this task rewrites an existing `alert_rule` row.
- **One source of truth.** A rule the compiler emitted carries `compiled_from_workflow_id`
  and `graph_hash` and is **not hand-editable** — edit the graph and republish. A rule and a
  graph that can both be edited drift apart, and then neither describes what runs.
- **A plain-English reading of what runs.** D34's test of a rule parameterisation is that it
  renders back into one sentence. A workflow is several rules; it renders into several
  sentences, and they are rendered from the **compiled rules**, not from the graph, so the
  reading is of what the runtime will actually do.

This is also the substrate QGEN3 emits into. A generated workflow is a `WorkflowSpec` like
any other and goes through exactly this compiler (D25). Nothing here knows or cares whether
a person or an emitter assembled the spec.

**The Visual Workflow Backend Addendum v1.1 (WF01–WF08) is not in the repository.**
`DECISIONS.md` records it as reconstructed on 22 September and "still to be copied in";
`COVERAGE.md` marks G08 missing on the same grounds. The node vocabulary below is derived
from D16 alone. If the addendum is supplied before you start, it wins and this section is
reconciled to it — say where they differ, do not merge both.

## 1. Two kinds, one of them out of scope

| `kind` | Executes on | This task |
|---|---|---|
| `alert` | compiler → `alert_rule` → existing shift-runner evaluation | **built here** |
| `agent` | `workflow_run` + `workflow_node_state` durable engine (D16, waits on Q21E) | **refused** |

An agent graph needs to pause mid-execution (`HumanApproval`) and `alert_rule` has no run
state to pause. Refuse `kind = 'agent'` at the database (see §3), not only in the service —
a stored agent draft with nothing able to run it looks like a configured workflow.

## 2. `WorkflowSpec` — the node vocabulary

The graph UI is an input and a view (G08). The server stores, validates, versions and
executes. **Layout is not execution semantics**: node positions live beside the spec, never
inside it, and never enter the hash.

Node types are TypeScript — a closed registry, a deploy (D25's rule). The composition is a
row. From D16, every node maps onto something the runtime already evaluates:

| Node type | Compiles to | Parameters (all from `alert-rules.ts`, none new) |
|---|---|---|
| `ReadSignal` | the `signal` of a threshold leaf | `signal` — must be declared by the target class |
| `Threshold` | `signal-threshold` | `max` / `min`, `lookbackReadings`, `requiredBreaches` |
| `FreshnessGate` | `no-telemetry` | none |
| `PredictionSeverity` | `prediction-severity` | `atLeast`, `clientScenarioSlug` |
| `FuelLoss` | `fuel-loss` | `FuelLossParams` as-is |
| `ChainOrigin` | `chain-origin` | `ChainOriginParams` as-is |
| `AllOf` / `AnyOf` | the one new composite trigger (§4) | children only |
| `Notify` | the rule's `severity`, `name`, `description` | severity from `SEVERITY_ORDER` |

A `WorkflowSpec` is: `kind`, the scope it applies to (the same four `applies_to` values
`alert_rule` already has, with the same required companions), the nodes, the edges, and
nothing else. Validation is structural and closed:

- every node type is in the registry; an unknown type is refused, naming it
- every parameter set passes **the existing `validateParams`** for the trigger it compiles to
  — call it, do not copy it. M > N, min ≥ max and `atLeast: 'none'` are refused by the same
  sentences hand-authored rules get
- every `ReadSignal` names a signal the target class declares (the tenant copy's
  `expected_signals`), refused otherwise
- the graph is acyclic, every path ends in exactly one `Notify`, and a composite has at least
  two children
- size caps — a node count and a depth cap, as named constants, the same reason the formula
  parser has `MAX_NODES` and `MAX_DEPTH`. **Do not invent the numbers; see §12.**

**No node carries free text that reaches evaluation.** D25 and D34: no expression ever
enters the alert path. Parameters are typed values; a node that accepted a string condition
would be exactly the capability D25 says the platform never grants.

## 3. Data model — what the database enforces

Three new tenant-owned tables and three columns on `alert_rule`. Every table: `tenant_id`,
row-level security `FORCE`d with the `tenant_isolation` policy, granted to `ta_app` —
`rls-coverage.spec.ts` will fail the suite the moment the entity exists without it.

```sql
workflow_definition (
  id uuid PK, tenant_id text NOT NULL,
  slug text NOT NULL,                 -- unique per tenant
  name text NOT NULL, description text,
  kind text NOT NULL,                 -- CHECK (kind = 'alert') for now; widened by a later
                                      -- migration when the agent runtime exists
  created_by, created_at, updated_at
)

workflow_version (
  id uuid PK, tenant_id text NOT NULL,
  workflow_id uuid NOT NULL REFERENCES workflow_definition,
  version int NOT NULL,               -- unique per workflow
  spec jsonb NOT NULL,                -- execution semantics only
  graph_hash text NOT NULL,           -- sha256 of the canonicalised spec
  status text NOT NULL,               -- CHECK IN ('draft','published','superseded','retired')
  source text NOT NULL DEFAULT 'manual',  -- CHECK IN ('manual','generated'); QGEN3 writes 'generated'
  proposal_id uuid,                   -- NULL unless source = 'generated'; FK added by QGEN1
  published_by, published_at, created_at
)

workflow_layout (
  workflow_version_id uuid PK REFERENCES workflow_version, tenant_id text NOT NULL,
  positions jsonb NOT NULL, updated_at
)
```

```sql
ALTER TABLE alert_rule
  ADD COLUMN compiled_from_workflow_id uuid REFERENCES workflow_definition,
  ADD COLUMN compiled_from_version_id  uuid REFERENCES workflow_version,
  ADD COLUMN graph_hash text;
```

What the database refuses, each because a service check loses to a concurrent write or to a
second door:

1. **A published version is immutable** (D05, G13). A trigger refuses `UPDATE` of `spec`,
   `graph_hash` or `kind`-relevant content on any row whose status is not `draft`. Status may
   move `published → superseded | retired` and nowhere else.
2. **At most one published version per workflow** — a partial unique index on
   `(workflow_id) WHERE status = 'published'`.
3. **Compiled rules are not hand-editable** (D16). A trigger on `alert_rule` refuses an
   `UPDATE` that changes `trigger`, `params`, `applies_to`, `plant_id`, `source_system`,
   `external_id`, `equipment_class_slug` or `severity` on a row where
   `compiled_from_workflow_id IS NOT NULL`. The compiler never updates a compiled rule's
   content either: republishing **disables** the previous version's rules and **inserts**
   new ones. Alert events point at the rule that raised them, so a rule is switched off,
   never rewritten and never deleted (the `alert-rule.entity.ts` reasoning).
4. **The three provenance columns travel together** — a CHECK that all three are NULL or all
   three are NOT NULL.
5. **The composite trigger is compiler-only** — a CHECK that `trigger = '<composite>'`
   implies `compiled_from_workflow_id IS NOT NULL`. A hand-written composite would be the
   one rule kind with no graph to read it back from.
6. **`kind = 'agent'` is refused** by the CHECK in `workflow_definition`.

`graph_hash` is computed over a canonical form — keys sorted, node ids normalised, layout
excluded — so moving a node on the canvas is not a new graph and two identical graphs hash
the same.

## 4. The composite trigger — one new kind, not a second runtime

D16: the only shape that does not fit the existing table is multi-condition AND/OR with a
sustained window, and that is **one new trigger kind**. Add it to `AlertTrigger`, to
`validateParams`, to `evaluateRule`, and to the renderer — the same four places every other
kind lives, so the shift runner evaluates it with no change of its own.

Its parameters are a **tree of the existing leaf parameter sets** combined by `allOf` /
`anyOf`: a structured value, never an expression string. Each leaf is evaluated by the code
that already evaluates that leaf kind (`signalWindows` and the M-of-N count for thresholds)
— do not re-implement a leaf inside the composite.

Two things about it are **not decided** and are in §12: whether D16's "compiled expression"
means this parameter tree or a formula-compiler plan, and what "sustained window" means for
a composite (each leaf's own M-of-N, or a window over the combined condition). Do not choose.

Add the composite to `alert.controller.ts`'s `TRIGGERS` list **only** if the CHECK in §3.5
makes a direct `POST /alerts/rules` with it fail at the database; otherwise leave it out of
the DTO so the API refuses it before the database has to. Either way, test that the direct
path is refused.

## 5. Assembly — selections + library → `WorkflowSpec`

D25: an emitter is seeded by user selection from lists, never by an open request. Assembly is
the deterministic half of that, usable by a person in the console today and by QGEN3 later.

```
POST /api/v1/workflows/assemble
{ target: { appliesTo, sourceSystem?, externalId?, plantId?, equipmentClassSlug? },
  failureModeCode?: string,      -- from the tenant's class copy
  alertTemplateSlugs?: string[], -- the tenant's copies of published alert templates
  combine?: 'allOf' | 'anyOf' }
→ { spec: WorkflowSpec, rendering: string[], unresolved: [...] }
```

It reads only the tenant's own copies — `alert_rule` rows copied from
`alert_rule_template`, `client_equipment_class_failure_mode.signals`, the class copy's
declared signals. It writes nothing. A failure mode whose signals have no copied template
returns them under `unresolved` with the reason; **it does not invent a threshold** (G07: no
fabricated OEM limits). The person, or QGEN3, fills it or drops it.

Whether there is a separate **workflow template** library table is open (§12). QREC0's scope
named "workflow templates"; nothing on `main` holds them. Until answered, assembly composes
from alert templates and failure modes only.

## 6. Endpoints and capabilities

| Route | Capability | Does |
|---|---|---|
| `POST /workflows/assemble` | `alert.author` | §5, writes nothing |
| `GET /workflows`, `GET /workflows/:id` | `prediction.read` | list, with each version's status and rendering |
| `POST /workflows` | `alert.author` | create definition + draft version 1 |
| `PUT /workflows/:id/versions/:v/spec` | `alert.author` | replace a **draft** spec; 409 on anything else |
| `PUT /workflows/:id/versions/:v/layout` | `alert.author` | positions only; never changes the hash |
| `POST /workflows/:id/versions/:v/compile` | `alert.author` | dry-run: validated spec, the rules it **would** write, their rendering, per-machine readiness (§7). Writes nothing |
| `POST /workflows/:id/versions/:v/publish` | `alert.author` | compile and write, one transaction |
| `POST /workflows/:id/retire` | `alert.author` | disable every compiled rule, status `retired` |
| `POST /workflows/:id/versions` | `alert.author` | new draft copied from the published version |

`alert.author` because a published alert workflow *is* alert rules, and that capability
already gates writing them. Reads reuse `prediction.read` for the controller's own stated
reason. G03's operator drafts and delegated Alert Admin are in §12 — do not add a capability
without the answer.

**Publish is idempotent.** Publishing a version already `published` returns the same rules
and writes nothing. It takes `pessimistic_write` on the `workflow_definition` row inside the
transaction that writes — the same lesson as the import batch lock: two overlapping publishes
must not both supersede the old version and both insert rules.

`PATCH /alerts/rules/:id` on a compiled rule returns **409** with a sentence pointing at the
workflow; the trigger in §3.3 is the backstop, not the message. Enable/disable on a compiled
rule: see §12.

## 7. Readiness — a rule that cannot fire must not look configured

`alert.service.ts` already refuses a rule pointing at a machine not in the account, because
"a rule … that looks configured and never fires is the most expensive way for an alert to be
wrong". Compile carries the same reasoning to signals. For each machine the scope covers,
compile reports, per leaf:

| State | Reason |
|---|---|
| `ready` | signal bound, readings within `stale_after_seconds` |
| `not_configured` | `unbound` — the machine has no binding for the signal |
| `blocked` | `stale` / `no_readings` — Q08S s3's two states, kept distinct |

Use the existing binding and freshness resolution — do not write a second one. Equipment
scope with any leaf `unbound` **refuses publish**, same as the existing machine check. For
plant and class scope, see §12.

## 8. The renderer — the plan in plain English

A pure function, framework-free, next to `describeSignalThresholdRule` and importable the
same way. Input: the compiled rules (not the graph). Output: one sentence per rule.

- `signal-threshold` → **reuse `describeSignalThresholdRule` unchanged.**
- every other trigger kind, including the composite, gets its own sentence. A composite
  renders its leaves joined with "and" / "or", each leaf in the same words it would get on
  its own — one vocabulary, not two.
- signal display names and units come from the binding, as they do today.
- a closed-registry test, like the executor registry's: **every `AlertTrigger` member has a
  renderer**, so adding a trigger kind without one fails the suite.

## 9. Out of scope

- The agent runtime, `workflow_run`, `workflow_node_state`, `HumanApproval` — D16, Q21E.
- Historical replay and its gate — QGEN1 (D28). A hand-authored workflow publishes without
  it here; whether it later gets replay as information is in §12.
- Proposals, emitters, provenance beyond the `source` / `proposal_id` columns — QGEN1, QGEN3.
- Migrating existing hand-authored rules into graphs. D16 forbids it by design.
- Any change to how the shift runner calls `evaluateWindow`.
- Anything under `frontend/`. Report the response shapes the canvas needs.
- New npm dependencies — none are approved.

## 10. Tests

Refusals are attempted, not asserted to exist.

1. A single `Threshold` graph compiles to one `signal-threshold` rule whose `params` equal
   what a hand-authored rule with the same values would hold, and which `evaluateRule` fires
   at 6/10 and not at 5/10 — the QALERT2 boundary, through the compiler.
2. Every node type in the registry compiles; an unknown node type is refused, named.
3. M > N in a node → the **same sentence** `validateParams` gives a hand-written rule.
4. A `ReadSignal` naming a signal the class does not declare → refused, named.
5. A cycle, a path with no `Notify`, a composite with one child, a graph over the caps →
   each refused.
6. `INSERT` a `workflow_definition` with `kind = 'agent'` directly → the database refuses.
7. `UPDATE` the `spec` of a published version directly → the database refuses.
8. Insert a second `published` version for one workflow directly → the database refuses.
9. `UPDATE alert_rule SET params = …` on a compiled rule directly → the database refuses;
   `PATCH /alerts/rules/:id` → 409. A hand-authored rule beside it still updates.
10. `POST /alerts/rules` with the composite trigger → refused (API or database, whichever
    §4 settles), and a direct `INSERT` with no workflow id → the database refuses.
11. Republish: version 2 publishes → version 1's rules are `enabled = false` and unchanged in
    content, version 2's are new rows, version 1 is `superseded`. Alert events raised by
    version 1's rules still resolve to their rule.
12. **Concurrent publish** — two `publish` calls on the same draft through
    `Promise.allSettled`: both settle without error, one set of rules exists, one version is
    `published`.
13. Moving nodes (layout only) → `graph_hash` unchanged; changing one threshold → changed.
14. The composite: AND of two leaves fires only when both leaves' own M-of-N hold; OR fires
    when either does. Leaves evaluated by the existing leaf code — assert by a leaf case that
    differs only in M.
15. Renderer: every `AlertTrigger` has one (closed-registry test); a threshold renders
    byte-identical to `describeSignalThresholdRule`; a composite renders its leaves in the
    same words.
16. Equipment-scope publish with an unbound signal → refused with `unbound`; compile on the
    same graph returns the per-machine readiness without writing.
17. Assemble with a failure mode one of whose signals has no template → that signal under
    `unresolved`, and no threshold value appears anywhere in the spec for it.
18. Hand-authored rules created before the migration evaluate identically after it — seed
    one, migrate, evaluate.
19. RLS: tenant B cannot read, compile or publish tenant A's workflow, and cannot see its
    compiled rules.
20. Down path: **`WorkflowCompiler<timestamp>`'s** down migration, named, drops the three
    tables and the three columns and leaves seeded hand-authored rules intact.

**Seed before you migrate** — the down-path test and test 18 seed `alert_rule` rows first.

## 11. Done when

- `npm run build && npm run test:db` green; `npm run lint` clean (it carries the encoding
  check). Counts before and after on a worktree off `origin/main`, naming the base SHA.
- Migration timestamp assigned immediately before the MR, after the last merge-in; chain
  clean from empty; down path named.
- Report: commit SHA; files created and changed; test counts with base SHA; how §12 was
  answered and where each answer lives in code; every assumption you had to make; anything
  not implemented, with the reason.

**One line for the task doc:** a workflow is how a person draws an alert, and the compiler
is what turns the drawing into the rows the runtime already knows how to evaluate — so the
graph is the only thing anyone edits, and the sentence is read from what actually runs.

---

## 12. Questions — answer before starting

1. **The addendum.** WF01–WF08 is not in the repository. Supply it, or accept the
   D16-derived vocabulary in §2 as QWF1's? *Recommendation:* supply it if it exists in any
   form — a node vocabulary is exactly the kind of thing that is expensive to change after
   QGEN3 emits into it. If not, accept §2 and record that as a decision.
2. **The composite's shape.** D16 says the new trigger holds "a compiled expression"; D25 and
   D34 say no expression enters the alert path. Is the composite a structured tree of
   existing leaf parameters (§4), or a formula-compiler plan using QCE5's `compare` and
   `count_exceeding`? *Recommendation:* the parameter tree. It satisfies D25 literally,
   reuses the leaf evaluators, and renders in the words the leaves already use.
3. **"Sustained window" for a composite.** Each leaf keeps its own M-of-N, or a single
   window applies to the combined condition (e.g. "both true in 6 of the last 10 readings",
   which needs readings aligned across signals)? *Recommendation:* each leaf keeps its own
   M-of-N for QWF1; a combined window needs a time-alignment rule nobody has decided.
4. **Graph size caps.** No decision names a maximum node count or depth for a workflow.
   *Recommendation:* Deepak names them; they live in one named constant each.
5. **Workflow templates.** QREC0's scope listed "workflow templates"; none exist on `main`.
   Is a platform `workflow_template` table (copied on grant, D04) part of QWF1, a later
   task, or dropped because alert templates already serve? *Recommendation:* a later task;
   assemble from alert templates and failure modes now.
6. **Who may draft and who may publish.** G03 gives Operators workflow drafts and a
   delegated Alert Admin publish rights within an assigned scope; today `alert.author` is
   super admin and admin only, and no delegation scope exists. *Recommendation:* QWF1 gates
   everything on `alert.author`; operator drafting and delegated publish are a follow-up
   that adds a `workflow.draft` capability and a scope column, decided once.
7. **Enable/disable on a compiled rule.** May a person switch off one compiled rule through
   `POST /alerts/rules/:id/disable`, or only the whole workflow through retire?
   *Recommendation:* allow disable/enable — it is an operational act, not a semantic one,
   and switching off a noisy alert at 3 a.m. must not require a republish. Record it on the
   rule, and have the workflow's read show which of its rules are off.
8. **Plant- and class-scope publish when some machines are unbound.** Refuse, publish with
   the per-machine readiness listed, or refuse only when *no* covered machine is ready?
   *Recommendation:* publish, return the readiness list, and refuse only when no covered
   machine is ready — the class-scope equivalent of the existing machine check.
9. **Replay for hand-authored workflows.** Once QGEN1's harness exists, should publish show
   a 90-day fire count for a person's own graph too, as information rather than a gate?
   *Recommendation:* yes, informational only, in a follow-up after QGEN1; D28 makes it a
   gate only for generated rules.
