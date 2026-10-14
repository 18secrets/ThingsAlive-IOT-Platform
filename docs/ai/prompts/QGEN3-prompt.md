**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QGEN3 — The workflow emitter

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/workflow-emitter`

**Depends on:** QGEN1 (the proposal substrate and the replay harness) and QWF1 (assembly, the
compiler and the renderer) — **both must be merged**. If either has not, stop and report.
**Answer §9 first**; question 1 decides where threshold values may come from, and nothing
here is safe to build without it.

Read, in addition to what `CLAUDE.md` names: `docs/ai/DECISIONS.md` D16;
`docs/ai/decisions/ai-layer-decisions.md` D22, D25, D26, D27, D28, D34, D36;
`src/alert/services/alert-rules.ts`; the QWF1 assembly service, compiler and renderer; the
QGEN1 emitter interface, gate and replay service.

---

## 0. Why

D25's second emitter row:

| Emitter | Emits | Closed vocabulary | What rejects it |
|---|---|---|---|
| **Workflow** | a `WorkflowSpec` graph | registered node types, bound signals, published alert templates | the QWF1 compiler **plus historical replay** (D28) |

This task is mostly wiring. QWF1 already turns selections plus the library into a
`WorkflowSpec` deterministically; QGEN1 already gates, replays, routes and approves. The
emitter is the adapter between them: it takes a user's selection, produces a spec through
QWF1's assembly, and hands it to the substrate as a proposal of `kind = 'workflow'`.

The rule that makes it safe is D34's, restated in D25: **alert rules are stored parameters;
no expression ever enters the alert path. The model may select and fill parameters; it may
not write a condition.** A workflow spec is a typed graph of registered node types whose
parameters pass `validateParams` — there is nowhere in it for a condition to be written as
text. The worst output is a wrong arrangement of valid parts, and the replay gate is what
catches the wrong arrangements that would fire four thousand times.

**Prediction has no emitter** (D26). A workflow may include a `PredictionSeverity` node —
reacting to a score the scoring runtime produced — but nothing here produces a predicted
value, a forecast or a horizon.

## 1. What the emitter emits

A QWF1 `WorkflowSpec` with `kind = 'alert'`, nothing else:

- **`kind = 'agent'` is refused** — QWF1's CHECK refuses it at the database, and the emitter
  never constructs one (D16: agent graphs wait for the durable engine).
- Every node type comes from QWF1's registry; every parameter set passes `validateParams`.
- Every `ReadSignal` names a signal **bound** on the target machine — D25's "bound signals",
  not merely declared. A declared but unbound signal makes a rule that can never fire, which
  the replay would report as zero fires and QGEN1 would correctly label
  `insufficient_history`; the emitter catches it first and returns `needs_input`.
- **Threshold values have a named source.** Every `max` / `min` in the spec carries, in the
  proposal's `seed` and `gate_detail`, where it came from. Which sources are allowed is
  question 1. Until answered, the only permitted source is the tenant's copy of a published
  alert template (`alert_rule.template_slug` / `template_version`) — G07: no fabricated OEM
  limits, and an emitter-chosen number is exactly a fabricated limit.
- `lookbackReadings` and `requiredBreaches` are **omitted unless the source supplies them**,
  so the D34 / QALERT2 defaults apply by being unset (D32: unsupplied is not a declaration).

## 2. The emitter

Registered with QGEN1 as `kind = 'workflow'`. Seed, from lists (D25):

```ts
type WorkflowSeed = {
  target: { appliesTo: 'equipment'; sourceSystem: string; externalId: string }
        | { appliesTo: 'plant'; plantId: string }
        | { appliesTo: 'equipment-class'; equipmentClassSlug: string };
  intent: WorkflowIntent;          // a closed list — question 2
  failureModeCode?: string;        // from the tenant's class copy
  alertTemplateSlugs?: string[];   // the tenant's copies
  combine?: 'allOf' | 'anyOf';
};
```

The deterministic path (D36 — the only one built here):

1. Call **QWF1's assembly** with the seed. Do not re-implement assembly; if the emitter needs
   something assembly does not do, add it to assembly so the console's hand path gets it too.
2. If assembly returns anything under `unresolved`, return `needs_input` listing it. **Do not
   fill the gap.** No proposal row is written.
3. Otherwise return the spec. `render` is QWF1's renderer applied to the compiled rules — the
   approver reads the same sentences a person authoring by hand would see.

`target_versions` in the proposal record the class copy version, each template version read,
and each binding version id for every `ReadSignal` — so QGEN1's approval recheck refuses a
proposal whose signals were rebound after the replay ran over them.

## 3. The gate for a workflow

QGEN1's gate, `kind = 'workflow'`, unchanged — this task configures it, it does not extend it:

1. **Compile** — QWF1's compiler in dry-run, producing the rules it would write.
2. **Replay** — mandatory. Every compiled rule over every covered machine's last 90 days,
   through QGEN1's harness, which calls `evaluateRule` over shift windows built the way the
   shift runner builds them. Outcomes `pass` / `refuse` / `insufficient_history` exactly as
   D28 and QGEN1 define them; the fire-count bound is QGEN1's question 1, not decided here.
3. `gate_detail` carries, per machine: fires, windows evaluated, days and readings per
   signal, and the first few firing windows with their evidence — enough for an approver to
   see *why* a rule would have fired, not just how often.

**`insufficient_history` drafts are offered, labelled and disabled.** D28 and D22: a library
alert is valuable on a machine with no history, so the draft is not withheld — but it states
what history it had, and it materialises with its rules `enabled = false` (QGEN1 enforces
this in the database).

## 4. Materialisation

On approval, through **QWF1's publish** — the same transaction, lock and idempotency a
person's publish gets:

| Scope | Writes |
|---|---|
| `tenant` | a `workflow_definition` + `workflow_version` with `source = 'generated'` and `proposal_id` set (QWF1 reserved both columns; QGEN1 added the foreign key), published, compiling to `alert_rule` rows carrying `compiled_from_workflow_id` and `graph_hash` |
| `class` | a candidate for master admin review — **not built** until QGEN1 question 2 is answered |

Generated rules are therefore exactly as non-editable as hand-drawn compiled rules (D16):
edit the graph, republish — and a republished generated graph is a manual version, not a
generated one, because a person changed it. Record that: version 2 of a generated workflow
edited by hand has `source = 'manual'`.

Republishing a generated workflow after editing **does not** re-run the replay gate (QWF1
publishes without it); whether it should is QWF1's question 9.

## 5. Endpoints and capabilities

| Route | Capability | Does |
|---|---|---|
| `POST /workflow-proposals` | per question 3 | builds the seed from the selection, calls `ProposalService.propose('workflow', …)`; returns the proposal or `needs_input` |
| `GET /workflow-proposal-intents` | `prediction.read` | the closed intent list and what each needs picked |

Reading, approving and rejecting are QGEN1's `/proposals` routes. Approval materialises
through QWF1's publish, which needs `alert.author`; the approver must hold both the QGEN1
approval capability and `alert.author`, or the approval is refused with which one is missing.

## 6. Out of scope

- A language-model path — D36; a follow-up behind a flag, off by default, calling the same
  `emit` contract.
- Agent workflows, `HumanApproval`, durable runs — D16.
- Any node type, trigger kind or parameter QWF1 does not already have.
- Any predicted value, forecast or horizon — D26.
- Class-scope materialisation until QGEN1 question 2 is answered.
- Automatically enabling an `insufficient_history` draft when history accrues — QGEN1
  question 8.
- Anything under `frontend/`; no new npm dependencies.

## 7. Tests

Refusals attempted, not asserted to exist.

1. A failure mode whose signals all have copied templates and are bound on the machine →
   proposal compiles, replays, `pass` on a seeded quiet history, approves, and materialises a
   generated workflow whose rules equal what QWF1's hand publish produces for the same spec.
2. **Replay refuses a noisy rule:** seed 90 days in which the template's threshold is
   breached on most shifts → `refuse`; approval → refused by the database, not only the
   service.
3. **Zero history → `insufficient_history`, never `pass`.** Approve it → rules exist with
   `enabled = false`; flipping one directly to `true` → refused (until QGEN1 question 8).
4. A failure-mode signal with no copied template → `needs_input` naming the signal; no
   proposal written; **no threshold value appears anywhere**.
5. A signal declared but unbound on the machine → `needs_input`, not a proposal that replays
   to zero.
6. A spec with `kind = 'agent'` reaching the substrate (forced in the test) → the database
   refuses at materialisation.
7. A spec node carrying a string where a parameter is numeric, or an extra property → refused
   by the payload schema before compile.
8. Every threshold in an approved generated workflow traces to a template version recorded in
   the proposal — assert by walking the materialised rules back to `target_versions`.
9. Signal rebound after the replay → approval 409 naming the binding.
10. **Concurrent approve** via `Promise.allSettled` → both settle, one workflow, one set of
    rules.
11. **Concurrent propose** with one idempotency key → one proposal.
12. The approver lacking `alert.author` → refused, naming the capability; nothing written.
13. A generated workflow edited and republished by hand → version 2 `source = 'manual'`,
    version 1's rules disabled, provenance on version 1 intact.
14. **Replay never touches production (G10)**, through this kind: `alert_event`,
    `domain_event` and `work_order` counts unchanged by a gate that fires hundreds of times.
15. The rendering an approver reads equals QWF1's renderer output for the compiled rules,
    byte for byte.
16. There is no `prediction` intent and no node the emitter can construct that emits a
    predicted value.
17. RLS: tenant B cannot see, approve or replay tenant A's workflow proposals.

No migration is expected: QWF1 reserved `source` and `proposal_id`; QGEN1 added the foreign
key. **If you find you need one, stop and say why before writing it.**

## 8. Done when

- `npm run build && npm run test:db` green; `npm run lint` clean. Counts before and after on
  a worktree off `origin/main`, naming the base SHA.
- Report: commit SHA; files created and changed; test counts with base SHA; the intent list
  as built; for the seeded classes, which failure modes produce a proposal and which return
  `needs_input` (and why); measured gate time for one machine and for a class-scope target;
  how each §9 question was answered; every assumption; anything not implemented, with the
  reason.

**One line for the task doc:** the workflow emitter assembles alerts from what the library
already knows and lets 90 days of real telemetry say whether they would have been noise —
and where the library has no number, it asks rather than inventing one.

---

## 9. Questions — answer before starting

1. **Where may a threshold value come from?** D25 says the model "may select and fill
   parameters"; G07 forbids fabricated OEM limits. Allowed sources could be: the tenant's
   copy of a published alert template; the class's sensor normal range (`sensor.parameterSpecs`
   min/max); a value the user typed into the seed. *Recommendation:* template copies and
   user-typed values only. A sensor's normal range is a description of the sensor, not an
   alarm limit, and reusing it as one is how alerts become noise.
2. **The intent list.** No list exists. *Recommendation:* start with "watch this failure
   mode" (assemble from its signals' templates) and "combine these templates" (`allOf` /
   `anyOf`), and grow it as a deploy.
3. **Who may propose a workflow.** Proposing writes a draft and costs a 90-day replay per
   covered machine. `prediction.read` (everyone), `alert.author`, or a new capability?
   *Recommendation:* `alert.author`, because the replay cost is real and every proposal's
   approver must hold it anyway; revisit when G03's operator drafting is decided (QWF1
   question 6).
4. **Plant and class targets.** A plant- or class-scope workflow replays over every covered
   machine. Should the emitter allow those targets at all before QGEN1's machine cap is
   measured? *Recommendation:* equipment-scope only in QGEN3's first cut; widen once QGEN1
   reports the measured cost and Deepak sets the cap.
5. **Severity.** A `Notify` node needs a severity; templates carry one as shipped. May the
   emitter change it, or must it take the template's? *Recommendation:* take the template's;
   the approver can change it by editing the graph after approval, which makes it a manual
   version.
