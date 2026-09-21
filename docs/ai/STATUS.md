# Status

One task at a time. Evidence links, not conversation summaries. Never mark verified because
code compiles or an agent said done.

```text
Task: Q00 — repository map and shared contracts
State: verified, except the kit copy
Requirement IDs: G01–G14 mapped in COVERAGE.md; contracts per shared §3, §4, §5
Branch: feature/ai-layer, off feature/dev (5c0ea1ca)
Changed files: docs/ai/REPO_MAP.md, DECISIONS.md, STATUS.md, COVERAGE.md,
               docs/ai/contracts/{equipment-context,calculation-result,retrieval-hit,
               grounded-answer}.v1.schema.json, error-envelope.schema.json,
               test/contracts.spec.ts
Actual endpoint and contract: none — Q00 adds no routes
Tests run and result: npx jest test/contracts.spec.ts — 19 passed, 0 failed.
               Proved non-vacuous by mutation: failure_probability widened to number,
               additionalProperties dropped, stale removed from missing_inputs reasons,
               evidence_refs minItems removed, a $ref pointed at a missing schema, and
               required naming an undeclared property — all six caught, then reverted.
Not tested: cross-language (TypeScript/Python) type generation from these schemas.
               Deferred deliberately: no Python service exists in this repository, so
               there is no second language to generate for yet.
Blocking fact: the kit itself is not committed under docs/ai/. Every layer prompt opens
               by reading 01-SHARED-CONTRACT.md and REPO_MAP.md by relative path, so a
               fresh session following the prompts currently finds nothing.
Next exact task: copy ai-development-kit/ to docs/ai/ (one mechanical commit), then
               Q08S, A0 and Q21A in parallel.
```

## Sequence

Q00 → (A0, **Q08S**, Q21A in parallel) → Q21B → Q21C → Q21D → Q21E → Q22

Q08S is the signal binding layer and blocks every formula and Q21C. It joins to
`device-catalog` (`sensor` is the sensor definition, `tool_mapping` is the device's
expected channel list) and to `equipment_template` (scalar parameters such as tank
capacity, which a formula needs alongside its signals) rather than duplicating either.

## Prerequisites on the critical path

- **P1-142** — migrate the Railway database to a pgvector-capable image. Blocks Q21B
  entirely; rehearse the dump and restore on staging and record the downtime.
- **LLM provider and key** — blocks only Q21E's single budgeted live run.
