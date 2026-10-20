# QSPIKE1b — one bounded retry of the local LLM runtime

Measured 20 October 2026 on Railway (Development), in a throwaway service `qspike1b` created
for this spike. Every number below comes from the service's log lines starting `QSPIKE1b`
(`scripts/qspike1b/run.sh` prints them); nothing is hand-copied from elsewhere.

## Verdict

**Completed.** Qwen3-4B Q4_K_M ran to completion on Railway CPU, in every one of the eight
runs, including the two configurations meant to reproduce QSPIKE1's failure. With the
instruction sets the host has and threads equal to the cgroup quota, it generates at a
median **25.3 tokens/sec** and processes the prompt at **163 tokens/sec**.

What this does **not** explain: QSPIKE1's "no completed inference after hours". The worst
configuration here (no AVX, three times the quota in threads) still finished 128 tokens in
72 seconds. Neither a generic build nor thread over-subscription, alone or together,
reproduces a stall measured in hours on this host. QSPIKE1 used a different runtime build
(the `llama-cpp-python` wheel, harness never pushed) on a service with an 8-CPU quota, and
its thread count was not recorded, so its failure stays unexplained. What is settled is
that the model and the platform are not the problem.

## Host

From the spike container itself (and the same as the `scheduler` container checked first,
read-only, with `railway ssh`):

| | |
|---|---|
| CPU | AMD EPYC 9655P 96-Core Processor (Zen 5) |
| `avx`, `avx2`, `fma`, `f16c` | all present |
| `avx512f`, `avx512_vnni`, `avx_vnni` | all present |
| `nproc` | **48** |
| `cpu.max` | `2400000 100000` = **24 CPUs** |
| `memory.max` | 24,000,000,000 bytes = **24 GB** |

D35 recorded 8 cgroup cores and 8 GB for QSPIKE1's service. Railway limits are per service,
so D35's figures describe that service, not every container in the project.

`nproc` reports twice the quota. A runtime that sizes its thread pool from the visible count
over-subscribes; the runs below measure what that costs.

## Attempt

One image, `scripts/qspike1b/Dockerfile`, entirely separate from the platform `Dockerfile`:

- **llama.cpp** tag `b6000`, commit `4762ad7316dcdec20016ab5985fb46a27902204d`, built twice
  with `GGML_NATIVE=OFF` (a native build detects Railway's builder, not the host):
  - `generic`: `GGML_AVX`, `AVX2`, `FMA`, `F16C`, `AVX512`, `AVX512_VNNI`, `AVX_VNNI` all `OFF`
    (runtime reports `SSE3 SSSE3 BMI2`)
  - `isa`: all of those `ON` (runtime reports `AVX AVX_VNNI AVX2 F16C FMA BMI2 AVX512 AVX512_VNNI`)
- **Model:** `Qwen/Qwen3-4B-GGUF`, `Qwen3-4B-Q4_K_M.gguf`, sha256
  `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`, verified in the build
  and again at start. QSPIKE1's exact file is unknown (commit `1720281` is on no remote); this
  is the same size and quantisation, not provably the same file.
- **Inference:** `llama-cli -no-cnv --temp 0 --seed 1 -c 2048 -n 128 --ignore-eos`, prompt
  `scripts/qspike1b/prompt.txt` (94 tokens), 30-minute timeout per run, OpenMP.

The first deploy lost all eight runs to exit 127 within a second (the runtime image lacked
`libgomp1`). Nothing was inferred, so it is not counted as the attempt; the fix added a
preflight that prints the loader error instead.

## Numbers

Three runs at the quota, one at three times it (QSPIKE1's suspected ratio: 24 default
threads on an 8-CPU quota). Median / worst of three where there are three.

| build | threads | prompt, tokens/sec | generation, tokens/sec | load | peak RSS | wall |
|---|---|---|---|---|---|---|
| isa | 24 | **163.0** / 151.7 | **25.26** / 22.81 | 1.17 / 1.30 s | 4.51 GB | 7 / 8 s |
| generic | 24 | 44.9 / 42.4 | 17.15 / 14.08 | 0.37 / 0.37 s | 2.81 GB | 10 / 12 s |
| isa | 72 | 31.8 | 2.14 | 2.39 s | 4.51 GB | 65 s |
| generic | 72 | 36.5 | 1.77 | 1.07 s | 2.83 GB | 76 s |

Generation is over 127 timed tokens after the first; prompt processing over 94 tokens.
RSS is `/usr/bin/time` maximum resident set size (the `isa` build repacks weights for AVX-512,
hence the larger footprint).

What each comparison isolates:

- **The build, threads fixed at 24:** prompt processing **3.6×** faster with the host's
  instruction sets (163 vs 45), generation **1.5×** (25.3 vs 17.2).
- **Over-subscription, build fixed:** three times the quota cuts generation about **12×**
  (25.3 → 2.1) on `isa` and **10×** (17.2 → 1.8) on `generic`. Prompt processing suffers less.
- Both effects are large. Neither turns a 7-second inference into hours.

Not done, from §6: the reproducibility check from a **fresh** container. The three runs per
row shared one container. The spread above is within-container only.

Output quality is out of scope (§5), but one observation is recorded so nobody mistakes the
sample for a result: run 1's text is repetitive. The prompt was raw text without Qwen3's chat
template and `--ignore-eos` forced all 128 tokens; that measures throughput, not answers.

## Spend

Not read from Railway's billing; an estimate. Two image builds of about seven minutes each,
and about three and a half minutes of running at up to 24 CPUs and 4.5 GB. At Railway's
published per-minute CPU and memory rates that is well under one dollar, against QSPIKE1's
$1.18. The actual figure is on the project's usage page under `qspike1b`.

## Time

From the first `railway up` (06:42 IST) to the last run (01:29 UTC, 06:59 IST): about
**17 minutes** of the one-day budget, most of it builds.

## Service to remove

`qspike1b` in the Development environment. It exited after its runs and
`restartPolicyType: NEVER` keeps it from running again. Removing it is Deepak's.

## What this changes

Nothing is decided here. D36's flag stays off and QREC2 ships templates either way. What D36's
flag could now carry: a local 4B model on this host, correctly built and with threads set to
the cgroup quota, generates about 25 tokens a second for one request. Whether that suffices
depends on the shift-boundary batch's size and on a latency or cost target, and neither
exists. Two rules follow for any future local runtime, whatever it serves: **set the thread
count from `cpu.max`, never from `nproc`**, and build with the host's instruction sets.
