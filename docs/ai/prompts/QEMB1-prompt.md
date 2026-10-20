**Status: draft for Deepak's review** — drafted 2026-10-20 from the recorded decisions and
Tapas's two answers of the same day (no pgvector for now; `@huggingface/transformers`
approved by name). Nothing here is decided that a decision file does not already decide.

# QEMB1 — the embedding profile, and semantic search over the library, without pgvector

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/qemb1`

**Depends on:** nothing that is not merged. The register listed it as **blocked on a
pgvector image on Railway** (P1-142). D47 removes that block: vectors are stored as
`real[]` in the same Postgres and compared by brute force until the corpus outgrows it.
Migration timestamp assigned immediately before the MR, after the last merge-in.

Decisions this task implements and must not re-derive: **D08** (the embedding profile is
pinned and immutable; changing it is a reindex, not a setting), **D09** (vectors live in the
database that holds tenancy, under the same row-level security), **D19** (`bge-small-en-v1.5`,
ONNX, in-process in the api), **D35** (measured on Railway: 148 docs/sec, 353 MB steady,
0.26 s cold load), **D47** (no pgvector for now). Rules: **G01, G07, G13**.

---

## 0. Why

QREC2's citations, QEVAL1's retrieval part and anything that answers a question from the
library all wait on one thing: a way to find the library entry that matches a sentence a
person wrote, when the words differ. "Hydraulic oil running hot" and "oil cooler blockage"
share no word, and a keyword search finds neither from the other.

That needs vectors, and the register put them behind pgvector, which Railway's standard
Postgres image does not carry. Changing the image of the database every service uses is the
riskiest change available on Development, and nothing about the corpus today needs an
index: a tenant's library is hundreds of entries, not millions. **So the vectors go in a
plain `real[]` column and are compared exhaustively** (D47). The measured latency (§9) says
when that stops being true; until then, pgvector would be an image change bought for no
gain.

### 0.1 What exists, and what does not, verified on `main` (`6135d46`)

- No `embedding_profile`, no vector storage, no model runtime in the api, no retrieval
  module (REPO_MAP: knowledge and retrieval **absent**).
- No knowledge corpus: no `knowledge_document`, `document_version` or `chunk`. The shared
  contract §4 describes them; nothing builds them.
- The library is rows since QREC0a: the tenant's copies are
  `client_equipment_class_failure_mode` and `client_equipment_class_recommendation`, both
  tenant-owned under `tenant_isolation`, both editable by the tenant.
- `forecast_model` (QML1) is the pattern for a pinned model registry: immutable rows, one
  `active` by partial unique index, a guard trigger.
- The api image is glibc (`node:22-bookworm-slim`) since QML1, which `onnxruntime-node`
  needs. `railway.scheduler.json` still builds the scheduler from the same `Dockerfile`.

## 1. The profile — `embedding_profile` (D08)

Platform-owned, no tenant column, one immutable row per exact model build:

| Column | Value for the seeded row |
|---|---|
| `key` | `bge-small-en-v1.5` |
| `model_repo`, `revision` | `BAAI/bge-small-en-v1.5` at `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` |
| `runtime` | `onnx-cpu` (CHECK) |
| `weights_file`, `weights_sha256` | `onnx/model.onnx`, `828e1496…940cf35` |
| `tokenizer_sha256` | of `tokenizer.json`, `d241a60d…f9e5c66` |
| `dimension` | 384 |
| `pooling`, `normalization`, `distance` | `cls`, `l2`, `cosine` (the model's own `1_Pooling/config.json` says CLS) |
| `query_prefix` | `Represent this sentence for searching relevant passages: ` (the model card's retrieval instruction, for queries only) |
| `max_tokens` | 512 |
| `language` | `en` |
| `chunker_version` | `library-entry@1`, the text builder in §2 — the contract's name for "how the input was made" |
| `license` | `mit` (the model card at that revision) |
| `status` | `active` / `retired`; at most one `active` (partial unique index) |

Nothing on a row changes except `status`, and only `active` → `retired`; never deleted.
A guard trigger refuses the rest — the `forecast_model` rule, for the same reason: every
stored vector names the profile that made it.

**The weights are checked against the row before the first embedding.** The service hashes
the ONNX file it is about to load and refuses to embed if the hash is not the active
profile's `weights_sha256`. A vector made by a model the profile does not describe is
indistinguishable from a correct one afterwards, so the check is at load, not in a test.

## 2. What is embedded, and how the text is made

**The tenant's library copies** (question 1): one vector per failure mode, one per
recommendation. Not the platform authoring rows — tenants search their own copies, which
they can edit — and no documents, because no document store exists (question 2).

The input text is built by one function, versioned as the profile's `chunker_version`:

- failure mode: `Failure mode: {name} ({code}). Equipment class: {classSlug}. Symptom: {symptom}. Signals: {signals}.`
- recommendation: `Recommended action for {failureModeName} ({failureModeCode}) on {classSlug}: {action}. Urgency: {urgency}.`

Passages are embedded **without** the query prefix; queries **with** it. That asymmetry is
the model's, not ours, and the profile records it.

`input_hash` = sha256 of the built text. A source whose text hashes the same as its stored
vector is not re-embedded.

## 3. Storage — `library_embedding`

```sql
library_embedding (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL,
  profile_id         uuid NOT NULL REFERENCES embedding_profile(id),
  source_kind        text NOT NULL,     -- 'failure_mode' | 'recommendation' (CHECK)
  failure_mode_id    uuid,              -- exactly one of these two, matching source_kind (CHECK)
  recommendation_id  uuid,
  input_hash         text NOT NULL,     -- sha256 hex (CHECK)
  vector             real[] NOT NULL,
  indexed_at         timestamptz NOT NULL DEFAULT now()
)
```

- **The source is a foreign key, not a loose id**, and it carries the tenant:
  `(tenant_id, failure_mode_id)` references the failure mode's `(tenant_id, id)`, which this
  migration makes unique. A vector cannot point at another account's row, and deleting the
  source deletes its vector (`ON DELETE CASCADE`) — an orphan vector would be a search hit
  for content that no longer exists.
- **One vector per source per profile**, by unique index.
- **The vector is checked by the database** on every insert and update: one dimension, no
  NULL element, exactly the profile's `dimension` long, unit length within 1e-3 (the dot
  product is the cosine only if it is), and the profile `active`. A CHECK cannot read
  another table, so this is a trigger.
- Row-level security: `tenant_isolation`, `FORCE`d. `ta_app` gets `SELECT, INSERT, UPDATE`
  — re-embedding an edited entry is an update; removal is the cascade.

## 4. Search — the semantic branch only (question 2)

`library_embedding_nearest(profile_id, query real[], k, class_slug)` — a SQL function,
`SECURITY INVOKER` so row-level security applies to it exactly as to a query:

- refuses a query vector whose length is not the profile's `dimension`, and reads only rows
  of that profile, so **vectors of two profiles are never compared** — not by convention,
  because the function will not do it;
- scores by dot product (`unnest` of the two arrays), orders by score then id, so ties are
  deterministic;
- `k` between 1 and 30 (the contract's semantic candidate count).

## 5. Endpoints

```
POST /api/v1/library-embeddings/search    { query, limit?, classSlug? }   prediction.read
POST /api/v1/library-embeddings/reindex   {}                              prediction.run
```

- **Search** returns `{ profile, method: 'semantic', hits: [...], coverage }`. A hit is
  `{ rank, kind, id, classSlug, code | failureModeCode, title, text }`. **No score**
  (question 6): the contract says relevance is not confidence, and a number between 0 and 1
  beside a maintenance answer will be read as one (G07). `coverage` is
  `{ sources, indexed, stale }`, computed on every search, so a library edited since the last
  reindex says so instead of silently returning old text.
- **Reindex** embeds every source whose text changed or has no vector, in batches, and
  returns `{ profile, embedded, unchanged, sources }`. Idempotent: a second call over
  unchanged content embeds nothing. Two calls together serialise on a transaction advisory
  lock per tenant, so the model runs once, not twice.
- With no model files present: `503 embedding_not_configured`. That is a state, not a boot
  failure — the assistant's precedent.

## 6. The runtime

- `@huggingface/transformers`, **exact version**, approved by name. Its CommonJS build,
  required lazily inside the real embedder, so a process that never embeds — the scheduler,
  every test — never loads `onnxruntime-node`.
- `env.allowRemoteModels = false`: the library never downloads at runtime. The model is
  loaded from `EMBEDDING_MODEL_DIR` (default `/app/models`) on first use (question 5).
- **The image bakes the files at build time**, fetched by `scripts/fetch-embedding-model.js`
  at the pinned revision and checked against pinned sha256s. The same script fills a
  developer's local directory for the opt-in real-model spec.
- `onnxruntime-node` ships native binaries for every platform; the runtime stage deletes the
  macOS and Windows ones and `onnxruntime-web`, which the Node build does not load
  (question 9).

## 7. Out of scope

- pgvector, any index structure, any change to the Postgres image (D47).
- Lexical search, exact-identifier matching, RRF fusion, `RetrievalHitV1`: they need the
  knowledge corpus, because a hit's required `document_version_id` and `chunk_id` do not
  exist for a library entry (question 2).
- Document ingestion, chunking, OCR.
- Automatic reindex on library edit (question 3).
- Changing a Railway variable or service.
- Anything under `frontend/`.

## 8. Tests

New spec `test/library-embedding.spec.ts`, added to `test:db`, with a deterministic fake
embedder behind the same interface (hashed bag of words, normalised), so the suite needs no
network and no model. One opt-in spec runs the real model when `EMBEDDING_MODEL_DIR` holds it.

1. Seeded profile is `active`, 384, `cls`, `l2`; a second `active` profile is refused by the
   database; editing the row is refused; deleting it is refused.
2. Reindex embeds every source; a second reindex embeds nothing; editing one failure mode's
   symptom re-embeds exactly that one.
3. **Concurrent reindex** (`Promise.allSettled`): both settle, one vector per source, the
   fake embedder ran once per source.
4. Search returns the expected entry first; ranks are 1..n; no score field; `classSlug`
   narrows.
5. Coverage reports `stale` after an edit and `0` after reindex.
6. **Refusals, attempted:** a 383-element vector; a NULL element; a vector of length 2 not
   of unit norm; a vector pointing at another tenant's failure mode; a vector under a
   retired profile; a query of the wrong dimension to the search function.
7. **Isolation, attempted:** tenant B searching sees none of tenant A's entries; tenant B
   cannot insert a vector for tenant A.
8. Deleting a failure mode deletes its vectors (and its recommendations' cascade).
9. Weights hash mismatch → the embedder refuses before embedding anything.
10. No model files → search answers `503 embedding_not_configured`.
11. **Migration down path**, named: revert `EmbeddingIndex1761500000000` by name, assert the
    tables, function and triggers are gone, re-run up.

## 9. Measure, and report

- Embedding throughput, docs/sec, at batch 1 and 16, on the machine you have, labelled.
- Brute-force search latency at 1k, 10k and 50k vectors in one tenant, median and p95.
- `node_modules` size delta. The image delta only if an image can be built; say so if not.

## 10. Done when

- `npm run build`, `npm run lint`, `npm test`, `npm run test:db` green. Counts before and
  after on a worktree off `origin/main`, naming the base SHA.
- Report: commit SHA, counts, measurements, every answer acted on, every assumption.

**One line for the task doc:** the library becomes searchable by meaning today, in the
database it already lives in, and the measurement says when it is worth an index.

---

## 11. Questions — answer before starting

1. **What does QEMB1 embed?** *Recommendation:* the tenant's copies of failure modes and
   recommendations. They are what QREC1 reads and what a tenant can edit; platform authoring
   rows are drafts and published templates nobody searches at a machine.
2. **Hybrid retrieval and `RetrievalHitV1` now?** *Recommendation:* no. QEMB1 is the semantic
   branch. Lexical, exact-identifier, RRF and the contract shape belong to the task that builds
   the knowledge corpus (QRET1), because `RetrievalHitV1` requires a `document_version_id` and
   a `chunk_id`, and inventing either for a library entry would put a fake identifier in a
   citation.
3. **When does indexing run?** *Recommendation:* on request, idempotent, with staleness shown
   on every search. A scheduler sweep after library edits is a follow-up once someone uses it.
4. **fp32 or quantised weights?** *Recommendation:* fp32 `onnx/model.onnx` as published by
   BAAI. An int8 build is a different model with different vectors, so it would be a second
   profile and a reindex, decided on measurement.
5. **Load at boot or first use?** *Recommendation:* first use. Files present means available;
   no new variable on any Railway service, and the api pays the ~350 MB only once somebody
   searches.
6. **Return the similarity score?** *Recommendation:* no, rank only (G07; contract §4).
7. **When to move to pgvector?** *Recommendation, not a decision:* when one tenant's vectors
   pass ~20k, or search p95 passes 250 ms on Development. Then one migration adds a `vector`
   column and an HNSW index; the profile and the vectors do not change.
8. **Capabilities.** *Recommendation:* search on `prediction.read`, the gate the
   recommendation evidence uses; reindex on `prediction.run`, because it writes.
9. **Prune `onnxruntime` binaries in the images?** *Recommendation:* yes, in both Dockerfiles:
   about 370 MB of macOS, Windows and WebAssembly runtime that a Linux Node process never loads.
