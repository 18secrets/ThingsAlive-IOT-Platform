# Status

One task at a time. Evidence links, not conversation summaries. Never mark verified because
code compiles or an agent said done.

```text
Task: Q00 — repository map and shared contracts
State: in_progress
Requirement IDs: G01–G14 mapping started; contracts per shared §3, §4, §5
Branch: feature/ai-layer, off feature/dev (5c0ea1ca)
Changed files: docs/ai/REPO_MAP.md, DECISIONS.md, STATUS.md, COVERAGE.md,
               docs/ai/contracts/*.schema.json
Actual endpoint and contract: none — Q00 adds no routes
Tests run and result: schemas validated with Draft 2020-12; a fixture context accepted,
               an unknown field rejected, an invented missing-input reason rejected.
               Run ad hoc, NOT yet committed as a spec — that is the remaining half.
Not tested: cross-language type generation; fixture identities as a committed suite
Blocking fact: the kit itself is not yet committed under docs/ai/, so the layer prompts'
               relative reads do not resolve
Next exact task: finish Q00 — commit the kit, add test/contracts.spec.ts and the shared
               fixture identities; then Q08S, A0 and Q21A in parallel
```

## Sequence

Q00 → (A0, **Q08S**, Q21A in parallel) → Q21B → Q21C → Q21D → Q21E → Q22

Q08S is the signal binding layer and blocks every formula and Q21C.
