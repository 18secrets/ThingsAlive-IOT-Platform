# QEMB1 — what bge-small costs, and what brute-force search costs

Measured 20 October 2026 by `scripts/embedding/measure.js` (every timing below is in its
output; nothing is hand-copied from elsewhere). **Not representative of Railway**: an Apple
M2 laptop (arm64, 8 cores), node v20.18.1, Postgres 14.16 (Homebrew), with a load average
of about 9 while it ran, because other test suites were running beside it. D35's Railway
figure for the same model is 148 docs/sec.

## Embedding

`BAAI/bge-small-en-v1.5` at `5c38ec7c…`, fp32 `onnx/model.onnx`, through
`@huggingface/transformers` 4.3.1 (onnxruntime-node 1.30.0), CLS pooling, normalised.

| | |
|---|---|
| model load (files already on disk) | 0.47 s |
| batch 1 | 38.6 docs/sec |
| batch 16 | 53.7 docs/sec |
| process RSS after embedding | 203 MB |

128 library-entry-sized texts per run, after one warm-up call. An earlier run on the same
machine, less loaded, gave about 100 docs/sec; the load matters more than the batch size.
At either figure a tenant library of a few hundred entries reindexes in seconds.

## Search

`library_embedding_nearest`, top 30, as `ta_app` under the tenant's session exactly as the
service calls it, over random unit vectors in one tenant (an exhaustive scan costs the same
whatever the vectors mean). 20 queries per size after 2 warm-up queries.

| vectors in the tenant | median | p95 |
|---|---|---|
| 1,000 | 70.6 ms | 85.0 ms |
| 10,000 | 575.6 ms | 802.8 ms |
| 50,000 | 3,332.5 ms | 4,793.6 ms |

Linear, as expected: about 0.07 ms per vector, almost all of it `unnest` and the dot
product. A tenant library today is hundreds of entries, so tens of milliseconds. **This is
the number that decides when pgvector is worth the image change** (D47): past ~3,000
vectors in one tenant, p95 passes 250 ms on this machine.

## Size

| | |
|---|---|
| `node_modules`, before (`origin/main` `6135d46`) | 282 MB |
| `node_modules`, after `npm install @huggingface/transformers@4.3.1` | 775 MB (+493 MB) |
| of which `onnxruntime-node` | 292 MB: darwin/arm64 87, win32/arm64 71, win32/x64 66, linux/x64 44, linux/arm64 24 |
| of which `onnxruntime-web` | 142 MB, not loaded by Node (checked: the model runs with it removed) |
| the model files baked into the api image | 134 MB (`onnx/model.onnx` 133.1 MB, tokenizer 0.7 MB) |

**The image itself was not measured: Docker is not available on this machine.** Both
Dockerfiles delete `onnxruntime-web` and the macOS and Windows runtimes after
`npm ci --omit=dev` (about 370 MB). What remains is an estimate, not a measurement: roughly
+130 MB of packages in both images, plus the 134 MB model in the api's. Measure it on the
first build.

`.npmrc` sets `onnxruntime-node-install=skip`. Without it, onnxruntime-node's install
script downloads the CUDA 12 runtime from NuGet on every Linux x64 install, in the images
and in CI.
