# Merged coding prompts

One kit root: `docs/ai/`. Process and backlog from this kit; the AI layers from
`Things-Alive-Layer-Prompts-Context-RAG`, copied to `docs/ai/layers/`.

**Attach to every coding session:** G01–G14 from `START-HERE.md`, plus the conventions
paragraph of §1 in `layers/01-SHARED-CONTRACT.md` (UUIDs, RFC3339, half-open intervals,
error envelope, If-Match, idempotency keys). Nothing else unless the prompt names it.

**One prompt per session. One merge request per prompt.** Never paste chat history;
`STATUS.md` is the memory.

Order: **Q00 → (A0, Q08S, Q21A in parallel) → Q21B → Q21C → Q21D → Q21E → Q22**

Q08S is the signal binding layer. It is not optional: no formula, prediction input or
readiness answer can resolve without it, and Q21C cannot be built on top of nothing.

---

## Q00 — repository inventory and shared contracts

Replaces Kit B Prompt 1 and layer P00. Run once. Do not run both originals.
**Done** — see `REPO_MAP.md`, `DECISIONS.md`, `COVERAGE.md`, `contracts/` and
`test/contracts.spec.ts`. Kept here for the record of what was asked for.

```text
We are building Things Alive's backend. The UI is developed manually.
Read docs/ai/START-HERE.md and the existing repository instructions.
Inspect the actual code and tests before accepting old completion claims.

Create docs/ai/REPO_MAP.md, DECISIONS.md, STATUS.md and COVERAGE.md. This is the
only repository map; do not create docs/ai-build/REPOSITORY-MAP.md as well.
Map logical modules: identity, catalog, equipment, telemetry, prediction, context,
knowledge, retrieval, agents, workflows and evaluation, each to its real path and
owning service. Map G01-G14 and M01-M11/C01-C10 to actual modules and evidence.
Mark each feature verified, partial, missing or unverified, naming the evidence.
Reuse equivalent APIs and jobs rather than introducing parallel systems.

Then create the shared contracts as real files, not prose: JSON Schema or OpenAPI
for EquipmentContextV1, CalculationResultV1, RetrievalHitV1, GroundedAnswerV1 and
the typed error envelope, per docs/ai/layers/01-SHARED-CONTRACT.md sections 3, 4
and 5. References are UUIDs with explicit revisions. Reject unexpected fields at
external and tool boundaries. Generate or validate matching TypeScript and Python
types using the repository's existing mechanism. Add the shared synthetic fixture
IDs and deterministic clock utilities; seed no fake OEM settings into live data.

Define the job envelope: event_id, event_type, schema_version, tenant_id from
trusted context, resource_id/version, context, run_id?, occurred_at,
correlation_id, causation_id. Use the durable queue that exists. Do not add Redis
or RabbitMQ by assumption; if only a PostgreSQL outbox exists, record that as the
mechanism rather than a gap.

Do not implement features. Do not change UI. No model calls, paid or local.
Test malformed payloads, nonfinite numbers, missing units and cross-language
serialization. Report which prerequisite infrastructure is genuinely absent,
which referenced source documents are missing from the repository, and the first
ready small task. Return a concise gap summary and the next task packet path.
```

---

## A0 and the AI layers

Each is a prepared file. Paste it whole, with the preamble above. No package body is
duplicated here, so there is one copy of each to maintain.

| Package | Paste | Runs after | Annex to attach |
|---|---|---|---|
| A0 | `layers/prompts-ai/A0.md` | Q00 | §8 |
| Q08S signal binding layer | `layers/prompts-ai/Q08S.md` | Q00 | §2, §2A |
| Q21A knowledge corpus | `layers/prompts-ai/P06.md` | A0, Q03, Q07 | §4 |
| Q21B embedding and vector index | `layers/prompts-ai/P07.md` | Q21A, pgvector migration | §4 |
| Q21C equipment context builder | `layers/prompts-ai/P05.md` | **Q08S**, Q09, Q13, Q14 | §2, §2A, §3 |
| Q21D authorized hybrid retrieval | `layers/prompts-ai/P08.md` | Q21B, Q21C | §3, §4 |
| Q21E grounded answers | `layers/prompts-ai/P09.md` | Q21D, Q17 | §3, §5, R01 |
| Q22 MCP adapter | `layers/prompts-ai/P10.md` | Q21E, Q19 | §5, R02 |

Q22 keeps the Q22-A…E sub-boundaries in `TASK-QUEUE.md`: pin protocol and one read
tool, then readiness and evidence tools, then propose/confirm with a server-issued
approval reference, then the negative tests through the real transport, then
run-status. The existing Q21 depends on Q21E.

Do not also run layer prompts P00, P04, P11, P12, P13 or P14 from `02-LAYER-PROMPTS.md`.
P00 is folded above; P01-P04 are already built; the rest are covered by Q packages.

---

## Implement one task

```text
Implement docs/ai/tasks/[TASK-ID].md.
Read START-HERE.md, current STATUS.md, REPO_MAP.md and the code and spec sections
that task names. Search filenames and symbols before opening large files. If you
need a file outside the task's read list, stop and say which and why.
Reuse the existing architecture and ordinary domain services.
Give a brief plan, then finish this task: code, necessary migrations,
OpenAPI and examples for the manual UI, and the specified tests.
Validate the real boundaries the change affects, not just service methods.
Run targeted tests and the repository's required checks. Fix relevant failures.
Do not change unrelated features, build UI, deploy, or mark a mock as live.
If a missing fact blocks safe implementation, record it and complete the
independent parts; invent no units, thresholds or credentials.
Update STATUS.md and COVERAGE.md with evidence rather than assurance.
Final response: what changed; tests passed, failed or not run; remaining blocker;
next task. Brief, unless a material risk needs explaining.
```

## Fix one failure

```text
Task: [TASK-ID]. Observed failure: [exact error or behavior].
Expected: [one sentence]. Evidence: [test, log file or request].
Reproduce it at the actual failing boundary and read only the relevant code.
Fix the cause with the smallest coherent change. Add a regression test that fails
before the fix and passes after it. Run affected and required checks.
Keep the settled architecture and unrelated behavior unchanged.
Update the task evidence. Report cause, fix and tests concisely.
```

## Resume in a fresh session

```text
Resume Things Alive backend development from docs/ai/STATUS.md.
Read START-HERE.md, REPO_MAP.md and the current task packet.
Verify the recorded working-tree state and the test evidence it claims.
Continue only the unfinished current task. Do not redo completed discovery and do
not trust an earlier conversation's completion claims. Follow the implement
prompt's completion rules. UI is manual. State a real blocker briefly if one
prevents progress.
```
