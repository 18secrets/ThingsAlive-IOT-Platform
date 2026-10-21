**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QSPIKE1b — one bounded retry of the local LLM runtime

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b spike/qspike1b-llm-runtime`

**Depends on:** QSPIKE1 (its finding, D35). **Blocks:** nothing (D36).

**Hard budget: one attempt, one calendar day of wall-clock time from the first command,
then stop.** Whatever you have at that point is the result. Write it up. A spike that
overruns its budget has measured a different question, how long an open-ended hunt takes,
and nobody asked that.

---

## 0. Why

QSPIKE1 measured the model stack on Railway (D35). Embeddings and TTM cleared their bar
with huge margins. The language model did not run. Qwen3-8B Q4_K_M and then Qwen3-4B,
through the prebuilt `llama-cpp-python` wheel, produced **no completed inference after
hours, twice**.

D35 reads that carefully. The 4B failed with **3 GB of memory headroom spare**, which rules
out memory pressure and points at the runtime. The likely cause is a generic prebuilt wheel
without AVX2 / AVX-512 / FMA for this host. *What was measured is that this build does not
work, not that the model cannot.*

That is a testable hypothesis, so it gets one test. It does not get more than one, because
D36 already took the generative layer off the critical path. QREC2 ships deterministic
sentence templates, and the model sits behind a feature flag that is off by default. **Nothing
depends on the answer.** A yes reopens a seam. A no costs nothing.

## 1. First, check the hypothesis is even possible

Before building anything, on the same kind of Railway container QSPIKE1 used (8 cgroup cores,
8 GB, per D35), record:

- `cat /proc/cpuinfo | grep -m1 flags`: specifically whether `avx`, `avx2`, `fma`, `f16c`,
  `avx512f` are present
- `nproc` and the cgroup CPU quota, which may differ
- the CPU model name

**If the host lacks AVX2, the hypothesis is not a missing build flag.** It is a host that
cannot do what the build would ask. Report that and stop. It answers the question without
spending the day.

## 2. The one attempt

Pick **one** route, the one Question 1 answers. Not both. Doing both turns one attempt into
two.

**Route L (recommended): llama.cpp built from source, with explicit CPU flags.** Same GGUF file
QSPIKE1 used (Qwen3-4B, the quantisation it ran), same prompt, same thread count. Only the build
changes. Turn native detection off and set the instruction-set flags to exactly what §1 found
on the host. A native build on a builder machine detects the builder's CPU, not Railway's,
and that may be the original defect over again. Record the exact CMake flags and the
llama.cpp commit.

**Route O: onnxruntime-genai** with a published Qwen3-4B ONNX CPU export. This changes the
runtime **and** the model format **and** possibly the quantisation at once. A success then
cannot say which of the three fixed it.

Whichever route: one container image, built from a Dockerfile under
`scripts/qspike1b/`, entirely separate from the platform `Dockerfile`. This spike must leave
nothing in the product image.

## 3. What to measure

One completed inference is the bar. If it completes, record:

| | |
|---|---|
| model file, quantisation, sha256 | |
| runtime, version or commit, build flags | |
| host CPU flags (from §1), cores used, threads set | |
| cold load: process start to model ready | seconds |
| prompt length, in tokens | use the fixed prompt in `scripts/qspike1b/prompt.txt` |
| **prompt processing**, tokens/sec | separate number |
| **generation**, tokens/sec | separate number, over at least 128 generated tokens |
| peak RSS | |
| three runs | median and max of each timing |

Report prompt and generation throughput separately. They differ by an order of magnitude
on CPU, and a single "tokens/sec" hides which one is the problem.

**Every inference gets a hard wall-clock timeout** (Question 3). QSPIKE1's runs went "hours"
without completing, and it is not recorded whether they were slow or hung. Your report must
be able to tell those apart. Log the token count every N tokens, so a timeout shows whether
anything was generated at all.

## 4. The report

`docs/ai/measurements/QSPIKE1b.md`:

```
## Verdict        completed | did not complete | host cannot (no AVX2)
## Host           flags, cores, model name
## Attempt        route, exact build, model file + hash
## Numbers        the §3 table, or the last observed state before the timeout
## Spend          Railway cost of the spike, for comparison with QSPIKE1's $1.18
## Time           wall-clock used, against the one-day budget
## What this changes   nothing is decided here; one paragraph on what D36's flag could now carry
```

**Do not convert tokens/sec into a verdict on whether the generative layer is "viable".**
Whether a throughput is good enough depends on the batch D36 puts behind the flag, and
no latency or cost target exists for that. State the numbers.

## 5. Out of scope

- A second route if the first fails. **The budget is the scope.**
- Qwen3-8B. The 4B is the cheaper test of the same hypothesis. If the 4B runs, the 8B is a
  follow-up, not a continuation.
- Any change to `src/`, migrations, the platform `Dockerfile` or either `railway*.json`.
- Wiring the model into QREC2's flag. That stays off and stays QREC2's (D36).
- Prompt quality, output quality, any evaluation of what the model says.
- Tuning beyond the build flags: no speculative decoding, no batching experiments.
- Anything under `frontend/`.

## 6. Tests

No test is added. Nothing in the product changes. Two checks go in the report instead:

1. **The negative is attempted, not presumed.** If the verdict is "did not complete", the report
   contains the timed-out run's log, including the last token count. A plan of what would have
   been run does not count.
2. **The positive is reproducible.** If it completed, a second run from a fresh container of the
   committed image reproduces the generation throughput within the spread reported.

## 7. Done when

- `npm run build && npm run test:db` pass on the branch. The branch adds only
  `scripts/qspike1b/`, the report and this prompt, so the counts equal the before-count taken
  on a worktree off `origin/main`, naming the base SHA.
- `npm run lint` clean (the encoding check covers `docs/`).
- The report is written, whatever the verdict, within the one-day budget.
- Any Railway service created for the spike is listed in the report, so Deepak can remove it.
- Commit and push. Open the MR. Do not merge.

**One line for the task doc:** QSPIKE1 showed this build of the runtime does not work, not that
the model cannot. This spends one day finding out which, and nothing waits on the answer.

---

## Questions — answer before starting

1. **Which route, L or O?** *Recommendation:* **L.** It changes one variable (the build) and keeps
   the model file, the quantisation and the prompt QSPIKE1 used, so a success or a failure is
   attributable. O changes three things at once.
2. **Railway access.** The test is only meaningful on Railway's CPU, and running it needs a
   deploy. `CLAUDE.md` makes Railway read-only and forbids `railway up` without an explicit,
   narrow exception. *Recommendation:* grant, in writing, the creation of **one new** service
   `qspike1b` in the development environment and `railway up` to **that service only**, with no
   variable changes on any existing service. Removing it afterwards is Deepak's. This matches the
   QOPS2 precedent for new services.
3. **Per-inference timeout.** *Recommendation:* 30 minutes. That is long enough that a slow-but-working
   build completes 128 tokens at even 0.1 token/sec, and short enough that three runs and a
   rebuild fit in the day. Deepak may prefer another number. The point is that one exists.
4. **Spend cap.** D35 records QSPIKE1 at $1.18. No cap is set for this spike. *Recommendation:*
   set one before starting, so stopping is not a judgement call made mid-run.
5. **QSPIKE1's harness and GGUF file.** The QSPIKE1 report (`1720281`) was never pushed and is not
   on `origin/main`. *Recommendation:* push that branch or share the harness and the exact model
   file name. Without them, Route L can still run, but it is no longer the same model file
   QSPIKE1 tried, which weakens the comparison. Record that if it happens.
6. **Report location.** No report directory exists on `main`. *Recommendation:*
   `docs/ai/measurements/`, shared with QML1-SIZE. Move QSPIKE1's report there when its
   branch is pushed.
