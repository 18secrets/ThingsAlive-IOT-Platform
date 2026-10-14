**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QGEN1 — The proposal substrate, the gate and historical replay

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/artifact-proposal`

**Depends on:** QPART1 (shipped — monthly partitions, `1758030000000-TelemetryPartitioning`),
QWF1 (the workflow compiler — **must be merged**; the gate calls it), QREC0 (shipped in
parts — failure modes and recommendations as rows, `1758100000000-LibraryContent`). **If QWF1
has not merged, stop and report.** **Answer §11 first**; questions 1–3 change the data model.

Read, in addition to what `CLAUDE.md` names: `docs/ai/decisions/ai-layer-decisions.md` D21,
D22, D25, D26, D27, D28, D36, D39; `docs/ai/DECISIONS.md` D04, D05, D14;
`docs/ai/layers/01-SHARED-CONTRACT.md` §5 (Proposal); `src/alert/services/alert-rules.ts`
(`evaluateRule`, `signalWindows`); `src/shift/services/shift-runner.service.ts`
(`evaluateAlerts` and how it builds a window); `src/kpi/services/telemetry-window-reader.ts`;
the QWF1 compiler.

---

## 0. Why

D25: generation is **typed emitters over a closed vocabulary**, not a general agent. One
substrate, several emitters — an `artifact_proposal` table and a **propose → compile → gate →
draft** pipeline with per-kind emitters plugged in. This task builds the substrate and the
gate. It ships **no emitter**: QGEN2 (KPI) and QGEN3 (workflow) plug in afterwards.

Three things the substrate exists to guarantee, each from a decision:

- **Nothing the model writes is executed as written** (D25). Every payload passes through a
  compiler or a schema that can refuse it. The substrate is where "can refuse" is enforced,
  once, for every kind.
- **A generated artifact is a draft, scope-routed, fully provenanced** (D27). Default is a
  tenant draft. Promotion to the library is always a human step, never inferred from
  confidence.
- **Anything that fires is replayed before anyone sees it** (D28). A rule that reads
  beautifully and would have raised four thousand alerts is wrong, and no amount of
  critique catches that — arithmetic does.

And one thing it must never do: **prediction has no emitter** (D26). No numeric value about
the future may originate from a language model. `prediction` is not a proposal kind, and the
database refuses it.

G09 is the frame for all of it: AI generates proposals; normal services enforce permission,
exact approval, resource versions and idempotency; success is reported only from persisted
results.

## 1. The pipeline

```
seed (user selection) ─▶ emitter ─▶ proposed ─▶ compile ─▶ gate ─▶ draft_ready ─▶ approve ─▶ materialised
                                         │            │          │                  │
                                         └▶ refused   └▶ refused └▶ refused         └▶ rejected / expired
```

| Step | Who | Writes |
|---|---|---|
| **seed** | a person, picking from lists (machine, failure mode, intent — D25) | nothing |
| **emit** | a registered emitter (QGEN2/3) | the proposal row, `status = 'proposed'` |
| **compile** | the kind's own compiler — QCE1 for KPI, QWF1 for workflow | `compile_result` |
| **gate** | deterministic checks per kind; **replay for anything that fires** | `gate_outcome`, a replay run |
| **approve** | the scope's approver (§5) | `approved_by`, `approved_at` |
| **materialise** | the kind's normal service — never the substrate writing target tables itself | the artifact, with provenance |

Each step is its own transaction and its own state change. Materialisation goes through the
**same service** a person would use (G09), so a generated KPI and a hand-written one cannot
differ in what was checked.

## 2. Data model — what the database enforces

All tenant-owned; RLS `FORCE`d with the `tenant_isolation` policy; granted to `ta_app`. The
platform-side candidate for class scope is in §5 and question 2.

```sql
artifact_proposal (
  id uuid PK, tenant_id text NOT NULL,
  kind text NOT NULL,                  -- CHECK IN ('kpi','workflow')  — never 'prediction' (D26)
  scope text NOT NULL DEFAULT 'tenant',-- CHECK IN ('tenant','class')   (D27)
  status text NOT NULL,                -- CHECK IN ('proposed','compile_refused','compiled',
                                       --   'gate_refused','draft_ready','approved',
                                       --   'rejected','materialised','expired')
  -- what was asked (shared contract §5)
  seed jsonb NOT NULL,                 -- the typed selection; never free text
  target jsonb NOT NULL,               -- machine / class copy / plant it is about
  target_versions jsonb NOT NULL,      -- class copy version, binding version ids, template versions read
  payload jsonb NOT NULL,              -- the exact typed artifact
  proposal_hash text NOT NULL,         -- sha256(kind, scope, target, target_versions, payload)
  idempotency_key text NOT NULL,
  -- provenance (D27)
  source text NOT NULL DEFAULT 'generated',  -- CHECK (source = 'generated')
  emitter_kind text NOT NULL, emitter_version text NOT NULL,
  model_id text, model_version text,   -- see question 4
  recommendation_id uuid,              -- see question 5
  evidence_bundle_id uuid,             -- see question 5
  evidence_hash text,
  -- outcomes
  compile_result jsonb,
  gate_outcome text,                   -- CHECK IN ('pass','refuse','insufficient_history','not_applicable')
  gate_detail jsonb,
  expires_at timestamptz NOT NULL,     -- duration: question 6
  proposed_by text NOT NULL,           -- the human whose selection seeded it, from the server
  approved_by text, approved_at timestamptz,
  rejected_by text, rejected_at timestamptz, rejection_reason text,
  materialised_ref jsonb,              -- the id(s) the normal service returned
  created_at, updated_at
)
UNIQUE (tenant_id, idempotency_key)
```

What the database refuses:

1. **`kind = 'prediction'`** — the CHECK. Test it by inserting one.
2. **A proposal's content is immutable** (G13). A trigger refuses `UPDATE` of `kind`,
   `scope`, `seed`, `target`, `target_versions`, `payload`, `proposal_hash`, the provenance
   columns and `proposed_by`. A changed artifact is a new proposal, not an edited one — the
   approver approves exactly the bytes that were gated.
3. **Status moves only forward along §1.** A trigger refuses any other transition, so
   `rejected → approved` and `materialised → anything` are impossible however the service is
   called.
4. **A refused gate cannot be approved** (D28: "the refusal is structured, not a warning the
   user can wave past"). CHECK: `status IN ('approved','materialised')` implies
   `gate_outcome IN ('pass','insufficient_history','not_applicable')`.
5. **`not_applicable` only for kinds that do not fire.** CHECK: `gate_outcome =
   'not_applicable'` implies `kind = 'kpi'`. A workflow cannot skip replay by claiming it
   does not apply.
6. **Approval fields travel together** — `approved_by` and `approved_at` both set or both
   null; same for rejection.
7. **Provenance is complete** — `emitter_kind` and `emitter_version` NOT NULL; `source` is
   always `'generated'`.

```sql
replay_run (
  id uuid PK, tenant_id text NOT NULL,
  proposal_id uuid NOT NULL REFERENCES artifact_proposal,
  source_system text NOT NULL, external_id text NOT NULL,
  window_from timestamptz NOT NULL, window_to timestamptz NOT NULL,
  compiler_version text NOT NULL,
  signals jsonb NOT NULL,          -- per signal: readings, days covered, first/last reading
  windows_evaluated int NOT NULL,
  fires int NOT NULL,
  fires_detail jsonb NOT NULL,     -- per shift window that fired: window, summary, evidence
  outcome text NOT NULL,           -- CHECK IN ('pass','refuse','insufficient_history')
  outcome_reason text NOT NULL,
  started_at, finished_at
)
```

`replay_run` **is** G10's separate run namespace: a replay's only output is rows here and the
proposal's `gate_detail`. It has no `alert_event`, no `domain_event`, no `work_order`, no
notification and no baseline anywhere in its write path. Immutable once written — a trigger
refuses `UPDATE`; a re-gate is a new run.

## 3. The gate

Deterministic, no model, per kind. The substrate owns the order and the recording; each kind
registers its checks.

| Kind | Compile | Gate |
|---|---|---|
| `kpi` | QCE1 `compileFormula` against the target class copy's declared signals, the operator registry, named formulas and `@params` | `not_applicable` for replay — a KPI does not fire. QGEN2 may add deterministic checks |
| `workflow` | QWF1's validator and compiler, dry-run — the compiled rules it **would** write | **historical replay**, mandatory |

A compile refusal sets `compile_refused` with the compiler's own message and stops. It is
not retried, re-prompted or repaired by the substrate — that would be a second author
nobody reviews.

### Historical replay (D28)

For each machine the proposal's target covers:

1. **Window.** The last 90 days to now — D14's hot window, the only full-resolution data in
   the database. Replay never reads the Parquet archive.
2. **Windows inside it.** Rebuild the machine's shift windows over the 90 days exactly as the
   shift runner does, and build each `WindowContext` the way `evaluateAlerts` does —
   readings carry `imei`, grouped per `(imei, signal)`. **Share the code** (G10): extract the
   window-building the runner uses into a function both call. A replay that windows
   differently from production is replaying a different rule.
3. **Evaluate** each compiled rule against each window with the pure **`evaluateRule`** —
   never `AlertService.evaluateWindow`, which writes `alert_event`. Count fires.
4. **History check, per bound signal.** `insufficient_history` when the signal has fewer
   than **14 days** of readings, or fewer than **200** readings, whichever binds first (D28,
   both numbers decided). For a multi-signal rule, any signal short makes the run
   `insufficient_history`. `outcome_reason` names the signal and what it had.
5. **Outcome.** With enough history: `pass` if the fire count is within bounds, `refuse` if
   not. **D28 does not set the bounds** — question 1. Do not invent them.

The proposal's `gate_outcome` across several machines: question 7.

**`insufficient_history` is not a pass** (D28, corrected 2026-09-30). A replay over a machine
with no history returns zero fires, which reads as clean and is the most dangerous possible
output — and on a newly commissioned machine it is the normal state. The draft is still
offered, because a library recommendation is valuable on day one (D22), but:

- it is labelled unvalidated in every response that carries it, stating what history it had
- **it cannot be auto-enabled**: materialisation writes its rules with `enabled = false`.
  Enforce this in the database — a CHECK or trigger on the materialised `alert_rule` keyed
  off the proposal's gate outcome, or an equivalent the database holds. How it later becomes
  enabled is question 8.

**Replay never touches production (G10).** Two enforcements, not one:

- the telemetry read runs in a `READ ONLY` transaction, so a write anywhere in that code path
  is refused by PostgreSQL rather than by review
- the replay service is constructed without access to the alert, event, work-order or
  baseline services — it cannot call what it is not given

**Cost.** QPART1 exists partly for this: 90 days per candidate rule. Bound `source_timestamp`
on both ends so partition pruning fires (the `TelemetryWindowReader` comment says how to
check it rather than assume it), read once per `(imei[], signal[], window)` rather than per
shift, and cap the machines one proposal may replay against in a named constant — question 9.

## 4. Approval and evidence freshness

Approval rechecks before it writes (shared contract §5: "authorized human confirmation
rechecks scope, versions and evidence freshness"):

- the approver's scope still covers the target
- every entry in `target_versions` is still current — the class copy version, the binding
  versions, the template versions. A signal rebound since the gate means the replay
  replayed a different machine
- the proposal has not expired
- the gate outcome permits approval (§2.4 — the database also refuses)

Any recheck failing returns **409** with which one, and the proposal stays `draft_ready` for
a fresh proposal to supersede. It is **not** re-gated in place: content is immutable and the
gate result belongs to the content it gated.

**Approve is idempotent.** Approving an approved proposal returns the same result and writes
nothing. Take `pessimistic_write` on the `artifact_proposal` row inside the transaction that
approves and materialises — two overlapping approvals must not materialise twice. Same rule
as the import batch lock, for the same reason.

**Propose is idempotent** on `(tenant_id, idempotency_key)`: a retried emit returns the
existing proposal. The unique index is the guarantee; the service catches the conflict and
returns the row.

## 5. Scope routing (D27)

| Scope | Meaning | Approver | Materialises as |
|---|---|---|---|
| `tenant` | specific to this tenant's configuration | tenant super admin | the tenant's own artifact (QGEN2: `client_formula`; QGEN3: a QWF1 workflow) |
| `class` | applies to every machine of this type | **master admin**, as a candidate library entry | a **draft** library row — never published by approval; publishing stays `catalog.publish` |

Default is `tenant`. Promotion from tenant to class is always a separate human act, never
inferred from model confidence, fire counts or recurrence. Master-admin-initiated authoring
is class-scoped by construction and routes with no special case.

**Class scope crosses the tenant boundary** and that is not decided — question 2. The
evidence behind a class proposal is one tenant's telemetry; the reviewer is Things Alive.
D39 says the platform has no read path into commercially sensitive tenant data. Do not build
the platform-side candidate until question 2 is answered; build `scope = 'tenant'` end to end
and refuse `scope = 'class'` at approval with a named reason if it is not.

D22's drafting controls — a draft only after **three occurrences or two machines**, and a
per-class weekly rate limit — were written for library recommendation drafts. Whether they
apply to class-scoped artifact proposals is question 10.

## 6. Endpoints and capabilities

| Route | Capability | Does |
|---|---|---|
| `GET /proposals` | `prediction.read` | the tenant's proposals, filterable by kind, status, target |
| `GET /proposals/:id` | `prediction.read` | payload, plain-English rendering, compile result, gate outcome with its replay runs, provenance, `unvalidated` flag |
| `POST /proposals/:id/approve` | per scope — question 3 | §4; materialises through the kind's service |
| `POST /proposals/:id/reject` | same as approve | records who and why |
| `GET /proposals/:id/replay-runs/:runId` | `prediction.read` | the fires, per window, with evidence |

There is **no** public `POST /proposals`. Proposals are created by emitters, invoked by the
QGEN2/QGEN3 routes from a user's selection; the substrate exposes an internal
`ProposalService.propose(scope, emitterKind, seed)` they call. A route that accepted an
arbitrary payload would let anyone skip the emitter's closed vocabulary.

The emitter interface lives in this task, with a **test-only emitter** to exercise it:

```ts
interface ArtifactEmitter<K extends ProposalKind> {
  kind: K; version: string;
  emit(seed: Seed<K>, ctx: EmitContext): Promise<EmitResult<K>>;   // payload or needs_input
  compile(payload, ctx): CompileResult;                             // delegates to QCE1 / QWF1
  render(payload, ctx): string[];                                   // plain English, deterministic
  materialise(payload, ctx, m: EntityManager): Promise<MaterialisedRef>;
}
```

A closed registry keyed by `kind`, the same shape as the operator and executor registries,
with a test that every `ProposalKind` has exactly one emitter registered — and that
`prediction` is not a `ProposalKind`.

## 7. States the UI must render

Every proposal response carries `status`, `gateOutcome`, and a `readiness` / `reason` pair in
the vocabulary the rest of the platform uses: `draft_ready` with `insufficient_history` is
`readiness: 'blocked'`, `reason: 'insufficient_history'` for enabling purposes, and the
response says so in a sentence — never a green badge. A replay that has not run is not a
replay that found nothing.

## 8. Out of scope

- Any emitter beyond the test-only one — QGEN2, QGEN3.
- Any language model, feature flag or prompt. D36: the generative layer is optional; nothing
  here calls one. `model_id` is a column, not a dependency.
- A prediction emitter, in any form — D26.
- The recommendation engine (QREC1) and evidence bundles (QREC2).
- Replay over archived Parquet — QARCH1.
- Notifications on new proposals.
- Anything under `frontend/`; no new npm dependencies.

## 9. Tests

Refusals attempted, not asserted to exist.

1. `INSERT` an `artifact_proposal` with `kind = 'prediction'` → the database refuses.
2. `UPDATE` the `payload` of a proposal directly → the database refuses.
3. Move a proposal `rejected → approved` directly → the database refuses.
4. Set `status = 'approved'` on a `gate_outcome = 'refuse'` proposal directly → refused.
5. A workflow proposal with `gate_outcome = 'not_applicable'` → refused.
6. **Concurrent propose** — two emits with the same idempotency key via
   `Promise.allSettled`: both settle, one row exists, both return it.
7. **Concurrent approve** — two approvals of one proposal via `Promise.allSettled`: both
   settle without error, one artifact is materialised, `materialised_ref` set once.
8. Compile refusal → `compile_refused`, the compiler's own message, nothing materialised.
9. **Replay boundaries (D28):** 13 days of readings → `insufficient_history`; 14 days but
   199 readings → `insufficient_history`; 14 days and 200 readings → evaluated. Name the
   signal in the reason.
10. **Zero history → `insufficient_history`, never `pass`.** Write it by name; it is the
    defect D28 was corrected for.
11. A rule whose fire count is outside the bound → `refuse`; inside → `pass` (once question 1
    gives the bound).
12. **Replay never touches production (G10):** count `alert_event`, `domain_event`,
    `work_order` and the baseline tables before and after a replay that fires many times →
    unchanged. Then, separately, make the replay path attempt a write inside its read
    transaction → PostgreSQL refuses it.
13. **Replay matches production:** seed a machine, run the shift runner over a window that
    fires; replay the same rule over the same window → same fire, same evidence summary.
14. Partition pruning: replay's query plan touches only partitions inside the 90 days.
15. `insufficient_history` approval → materialised rules have `enabled = false`; an attempt
    to insert or flip them to `true` directly → refused (until question 8 says how).
16. Approval after a binding version changed under the target → 409 naming the binding; the
    proposal is still `draft_ready`.
17. Approval after `expires_at` → 409; expiry is honoured without a background job.
18. Approval by a role without the scope's capability → 403; `scope = 'class'` approval →
    refused with its named reason until question 2 is answered.
19. Every `ProposalKind` has one emitter; `prediction` is not a member (compile-time and
    runtime).
20. RLS: tenant B cannot read tenant A's proposals or replay runs.
21. Down path: **`ArtifactProposal<timestamp>`'s** down migration, named, removes both tables
    and leaves `workflow_version.proposal_id` (QWF1) without its foreign key and intact.

**Seed before you migrate.**

## 10. Done when

- `npm run build && npm run test:db` green; `npm run lint` clean. Counts before and after on
  a worktree off `origin/main`, naming the base SHA.
- Migration timestamp assigned immediately before the MR, after the last merge-in; chain
  clean from empty; down path named.
- Report: commit SHA; files created and changed; test counts with base SHA; **measured
  replay cost** for one machine over 90 days and for the machine cap in question 9 (wall time
  and rows read — D24 says storage numbers are the ones nobody checks); how each §11 question
  was answered; every assumption; anything not implemented, with the reason.

**One line for the task doc:** a proposal is a typed draft that has to survive a compiler, a
replay over real history and a human before it becomes anything — and "no history" is a
fourth answer, never a pass.

---

## 11. Questions — answer before starting

1. **The replay bounds.** D28 says `pass` is "fire count within bounds" and gives no bound.
   What is it — a maximum fires per machine per 90 days, per week, a rate per shift window,
   and is there a minimum (a rule that would never have fired on a machine with a known
   history of the fault)? *Recommendation:* Deepak names a maximum per machine over the
   90-day window as one named constant, reported beside every result; a minimum is a later
   refinement once failure history is trustworthy.
2. **Class scope across the tenant boundary.** A class proposal is built from one tenant's
   evidence and reviewed by Things Alive; D39 gives the platform no read path into tenant
   data. What may reach the master admin? *Recommendation:* the tenant proposal stays in the
   tenant; promoting it creates a platform-side candidate carrying only the artifact payload
   and aggregate replay counts — no readings, no identifiers — and requires the tenant super
   admin to choose to submit it. Build tenant scope first; class scope as a follow-up.
3. **Approval capabilities.** Tenant approval is "tenant super admin" (D27); no capability
   names it. Class review is master admin. *Recommendation:* a new `proposal.approve`
   capability granted to `super admin`; class candidates reviewed under `catalog.write` and
   published only under `catalog.publish`, as today.
4. **Provenance when no model ran.** D27 records "the model id and version"; D36 makes the
   model optional, so a deterministic emitter produces proposals with no model. *Recommendation:*
   `emitter_kind` + `emitter_version` mandatory, `model_id` / `model_version` nullable and
   set only when a model contributed.
5. **What "the recommendation id that spawned it" points at before QREC1 exists.** No
   recommendation instances or evidence bundles exist yet; D25 seeds emitters from user
   selections. *Recommendation:* `seed` records the selection (including the library
   recommendation or failure mode picked); `recommendation_id` and `evidence_bundle_id` stay
   nullable and are made NOT NULL for engine-seeded proposals once QREC1/QREC2 exist.
6. **Proposal expiry.** The shared contract requires an expiry; no duration is decided.
   *Recommendation:* Deepak names it; one constant. Expiry matters less than the
   version recheck, which already catches the dangerous case.
7. **Several machines, one outcome.** A class-copy or plant-scope workflow replays over many
   machines. Is the proposal's outcome the worst machine's, a majority, or per-machine with
   materialisation limited to the machines that passed? *Recommendation:* worst-case —
   any `refuse` refuses; otherwise any `insufficient_history` makes it unvalidated — with
   the per-machine runs always shown.
8. **How an unvalidated rule becomes enabled.** D28 says it "cannot be auto-enabled" and
   nothing more. *Recommendation:* a person with `alert.author` enables it explicitly, and
   the act is recorded with the history it had at the time; additionally, once the machine
   has 14 days and 200 readings, the UI may offer a re-gate as a new proposal.
9. **Replay machine cap per proposal.** No decision names one. *Recommendation:* Deepak names
   it after this task reports the measured cost per machine.
10. **D22's drafting controls for class proposals.** Do "three occurrences or two machines"
    and the weekly per-class rate limit apply to class-scoped artifact proposals, and what is
    the weekly number (D22 does not give one)? *Recommendation:* yes to both, enforced in the
    database; Deepak names the weekly number.
11. **Replay window semantics when a proposal targets a machine with fewer than 90 days
    since commissioning.** Replay the days it has, or treat any window shorter than 90 days
    as `insufficient_history`? *Recommendation:* replay what exists; D28's 14-day / 200-reading
    floor is the only history test, and the result states the days covered.
