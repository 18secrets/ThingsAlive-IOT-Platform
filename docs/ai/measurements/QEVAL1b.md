# QEVAL1b — first run report (part 1b, the retrieval eval)

Run 20 October 2026 from branch `feature/qeval1b-retrieval`, which is QEVAL1a (!132) with
QEMB1 (!134) merged in, over base `origin/main` `6135d46`. QEVAL1a's report
(`QEVAL1.md`) records the state before this part existed; its line that `retrieval` waits on
QEMB1 is superseded here.

## Verdict

**No retrieval-quality number exists yet.** The eval is built, tested, and has run end to end
with the real model, but only over a smoke golden set on seeded library content:

| | |
|---|---|
| Golden set | None authored (QEVAL1 question 3). `docs/ai/eval/retrieval/authored/` is empty on purpose. The only set is `smoke-demo-excavator.json`, three questions written while building the harness, labelled `smoke`. |
| Development | QEMB1 is not merged, so no account has vectors there. Not queried. |
| Isolation | The one gated check **passed** on the smoke run (3 probes, 0 cross-account hits), and the spec proves the gate fails on a planted hit. |

## What it evaluates

QEMB1 as it ships: semantic search only, bge-small-en-v1.5 at `5c38ec7c…`, vectors in
`real[]`, compared by `library_embedding_nearest` under each account's row-level security.
The eval calls that same function and the same embedder (with the profile's query prefix),
so its ranking is the api's ranking; the spec asserts they are equal.

QEVAL1 §3 describes the hybrid the shared contract specifies (top 30 semantic + top 30
lexical, exact-identifier matches, RRF with constant 60, at most 8 chunks). None of the
lexical, exact-identifier or fusion parts is built (D47), so they are reported as `null`
with that reason rather than as zero. When they are built, the split by method is already
in the summary's shape.

## The smoke run

A fresh local database (`ta2_eval_retrieval_smoke`, all 88 migrations), `seed:demo`, the demo
account's library indexed through QEMB1's own reindex with the real model files
(`scripts/embedding/fetch-model.js`, hashes verified by the runtime), then:

```
EMBEDDING_MODEL_DIR=<model dir> npm run eval -- --kind retrieval --dataset real \
  --golden docs/ai/eval/retrieval/smoke-demo-excavator.json \
  --note "local seed:demo, real bge-small, 20 Oct 2026" --out qeval1b-smoke.json
```

| | |
|---|---|
| status | `completed`, exit 0 |
| dataset | asked `real`, recorded **`seeded`** (*"relabelled seeded: the golden set is a smoke set"*) |
| versions | scorer `qeval1b-1`; profile `bge-small-en-v1.5` @ `5c38ec7c…`, weights `828e1496…`, chunker `library-entry@1`; golden sha256 `680cced1…` |
| accounts | 1 (`demo-construction`) |
| pairs | 3 total, 3 scored, 0 excluded, 0 unreached |
| coverage | 6 library entries, 6 indexed, 0 stale |
| recall@8 | 1.0 over n = 3 |
| MRR | 0.833 over n = 3 |
| hit@1 | 0.667 over n = 3 |
| found by | semantic 4; lexical `null`, exact identifier `null` (not built) |
| isolation | 3 probes, **0** cross-account hits, gate **passed** |

Per question (ranks of the expected entries among 6 returned):

| question | expected | ranks | reciprocal rank |
|---|---|---|---|
| `smoke-coolant` | COOLANT_OVERHEAT failure mode | 1 | 1 |
| `smoke-hydraulic` | HYD_OVERHEAT failure mode + its recommendation | 1, 2 | 1 |
| `smoke-oil-pressure` | LOW_OIL_PRESSURE recommendation | 2 | 0.5 |

**Read none of this as retrieval quality.** Six library entries, each question filtered to the
one class that has them, and questions written by the person who wrote the harness: recall@8
over six candidates is 1.0 by construction. The run proves the CLI, the real model path, the
ledger, the dataset label, the isolation probe and the per-account results end to end.

## Before an authored set is run

- Someone who maintains this equipment writes the questions (question 3), per class, against
  real accounts' libraries; Deepak decides how many make a set worth reading.
- Each account is indexed first (QEMB1's `POST` reindex). The eval reads the index and never
  builds it, so stale entries are reported in `coverage`, not repaired.
- A result is tied to the profile and to the golden file's hash. A reindex under a new
  profile, or any edit to the file, is a different result.
