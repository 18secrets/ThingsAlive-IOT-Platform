# Retrieval golden sets (QEVAL1b)

The retrieval eval scores QEMB1's library search against a golden set: questions, each
naming the library entries a correct answer must find.

```
npm run eval -- --kind retrieval --dataset seeded|real --golden <file> [--tenant a,b] [--out summary.json]
```

## Files

| | |
|---|---|
| `smoke-demo-excavator.json` | Three questions over `seed:demo`'s demo excavator. **A smoke set**: written while building the harness, to prove it runs end to end. Its numbers say nothing about retrieval quality, and a run over it is labelled `seeded` whatever `--dataset` says. |
| `authored/` | Where domain-authored sets go. Empty until they are written (QEVAL1 question 3). |

## Format `ta2.retrieval-golden@1`

```json
{
  "format": "ta2.retrieval-golden@1",
  "name": "Excavator hydraulics",
  "version": "1",
  "kind": "authored",
  "authoredBy": "who wrote it",
  "authoredAt": "2026-11-02",
  "queries": [
    {
      "id": "hyd-01",
      "classSlug": "excavator",
      "text": "the question as a person would type it",
      "expect": [
        { "kind": "failure_mode", "classSlug": "excavator", "code": "HYD_OVERHEAT" },
        { "kind": "recommendation", "classSlug": "excavator", "code": "HYD_OVERHEAT",
          "action": "the recommendation's action text, exactly" }
      ]
    }
  ]
}
```

- **`kind`**: `smoke` or `authored`. Only an authored set's numbers are a measurement.
- **`queries[].id`**: unique in the file. It is what results are filed under, so keep an id
  when a question is reworded only slightly; give it a new id when the meaning changes.
- **`queries[].classSlug`**: optional. When present the search is filtered to that class,
  as it is when a machine's page asks. Omitted, the whole library is searched.
- **`expect`**: library entries by their keys, not row ids, because every account holds its
  own copy of the library. A recommendation is named by its failure-mode code and its
  action text, exactly.

## How it is scored

Per (account, question): the rank of each expected entry among up to 30 results,
**recall@8** (the shared contract's cut-off), **reciprocal rank** of the first expected
entry, and hit@1. Aggregates are means over the scored pairs, each with its denominator.

- An account whose library lacks the class or an expected entry is **excluded** under that
  reason, not scored as a miss.
- Every question is also run as every other account and as an account that owns nothing.
  **One hit on the first account's library fails the run** (QEVAL1 §3): this is the only
  gated check.
- The run records the embedding profile and the golden file's sha256. A reindex under a
  new profile, or any edit to the file, makes it a different result.
- Lexical and exact-identifier retrieval are not built (D47); their columns are `null`
  with that reason until they are.
