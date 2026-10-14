**Status: draft for Deepak's review** — drafted 2026-10-14 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QML1-SIZE — what `torch` costs the scheduler image

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b spike/qml1-size`

**Depends on:** nothing. **Blocks:** QML1 shipping (D35, D40 §2: "Measure it before QML1
ships").

**This is a measurement task.** It changes no source file, no migration and no Railway
setting. It builds candidate images locally, measures them and writes a report. If you find
yourself editing `src/`, stop.

---

## 0. Why

QSPIKE1 measured the model and found it nearly free: `granite-timeseries-ttm-r2` forecasts
**1000 series in 0.266 s, 568 MB peak**, on PyTorch fp32 CPU, in a Railway container of
**8 cgroup cores and 8 GB** (D35). It also found that TTM has no ONNX export, so it needs
`torch`, not a small ONNX runtime. That moves the cost from inference to the image: build
size, push and pull time, and cold start.

Nobody has measured that cost. D41 makes it one of the four triggers that split forecasting
into its own Railway service: *"adding `torch` pushes the image or deploy time to where the
scheduler's release cadence suffers (measured by QML1-SIZE)"*. This task is that
measurement. Without it, trigger 4 is a worry, not a reason, and D41 says each trigger must
be a reason.

Two facts from `origin/main` make this more than "add a line to the Dockerfile":

- **The image is `node:22-alpine`.** Alpine uses musl libc. PyTorch's published Linux
  wheels target glibc (manylinux). Expect `pip install torch` on Alpine to fail or fall back
  to a source build. Do not assume this. Measure it, because the answer decides whether
  the base image has to change.
- **The `api` and `scheduler` services build from the same `Dockerfile`.** Both
  `railway.json` and `railway.scheduler.json` point at it, with the same start command
  `node dist/main.js`. So `torch` added to that file lands in the **api** image too, though
  the api never forecasts. The report has to price that separately (variant E below).

## 1. What the QSPIKE1 report would have told you, and where it is

The QSPIKE1 report was committed as `1720281` on a branch that was never pushed (see
`docs/ai/task-register.md`, wave 4). That commit is not on `origin/main`. Use D35's
numbers as the reference. If you can reach `1720281` from any remote, read only the
Python package versions and the exact TTM model revision it ran, and use those. If you
cannot, say so in the report, pin the current stable versions at build time, and
record them. Do not guess what QSPIKE1 used.

## 2. The candidates

Build every variant for **`--platform linux/amd64`**. Railway runs amd64. An arm64 build
on a Mac laptop pulls different wheels with different sizes, and a size measured on it is
the size of an image that never ships.

| | Base | Contents | Purpose |
|---|---|---|---|
| **A** | `node:22-alpine` | the current `Dockerfile`, unchanged | baseline |
| **B** | `node:22-alpine` | A + `python3` + CPU `torch` | does `torch` install on musl at all? Record the outcome and the error, and stop this variant at the first failure. Do not work around it. |
| **C** | a glibc Node 22 image (recommend `node:22-bookworm-slim`) | A's stages, no Python | isolates the cost of the base-image change from the cost of `torch` |
| **D** | as C | C + `python3` + CPU-only `torch` (from PyTorch's CPU wheel index, not the default index, which pulls CUDA) + `granite-tsfm` and what it requires + the TTM weights baked in at a pinned revision | the scheduler image QML1 would ship |
| **E** | as C | D built as a **separate build target**, so the api target stays C | prices "torch only where it runs" |

Put the candidate Dockerfiles in `scripts/qml1-size/` (`Dockerfile.B`, `Dockerfile.C`,
`Dockerfile.D`; E is a target inside D). Also put `requirements.txt` there, with exact pins and
`--require-hashes`, plus the `measure.sh` that produced every number. Do not touch the root
`Dockerfile`, `.dockerignore`, `railway.json` or `railway.scheduler.json`. The measurement
must be reproducible from the committed script. A number nobody can regenerate does not
count as a measurement.

The weights are baked in at build time with `HF_HUB_OFFLINE=1` set at runtime. A container
that downloads its model on first start makes cold start depend on Hugging Face's
availability and egress. That is a different number from the one this task exists to
measure, and a worse design.

## 3. What to measure

For each variant that builds, five runs where timing is involved. Report the median and the
maximum, never the mean alone.

**Size**
1. Uncompressed image size (`docker image inspect --format '{{.Size}}'`).
2. Compressed size as pushed: the sum of compressed layer sizes, which is what a registry
   stores and what Railway pulls.
3. Layer breakdown (`docker history --no-trunc`). Name the layers that make up 90% of the
   delta from A.

**Build**
4. Cold build time, with no cache (`--no-cache`).
5. Warm rebuild after a one-line change under `src/`. This is the number a normal release
   pays. If the `torch` layer is ordered so that a `src/` change rebuilds it, report that as a
   finding. It is a layer-order defect, and fixing it is QML1's job, not this task's.

**Cold start**, run with `--cpus=8 --memory=8g` to match the container D35 observed:
6. Node: container start until `GET /api/v1/ready` answers 200, against a local Postgres.
   This shows whether `torch` in the image slows the Node process. If the model is lazily
   loaded (D40 §2), it should not.
7. Python: process start, `import torch`, load TTM, and the first inference of
   **1 series**, timed separately at each step.
8. Python: inference of **1000 series** after warm-up, for comparison with D35's 0.266 s.
   Use synthetic input of the model's own context length. The point is the runtime, not
   forecast quality.
9. Peak RSS of the Python process across 7 and 8 (`/usr/bin/time -v` or cgroup
   `memory.peak`), for comparison with D35's 568 MB.

**The laptop caveat.** If this machine is Apple Silicon, amd64 containers run under
emulation, and the timings in 6–9 are not Railway's. Sizes (1–3) do not depend on the
host, so they are valid anywhere. Report the host CPU architecture with every timing.
Label emulated timings **"emulated, not representative"**. Do not adjust them by a
factor. See Question 1 for how to get representative numbers.

## 4. The report

Write `docs/ai/measurements/QML1-SIZE.md` in exactly this shape, so it can be read
against D41 without interpretation:

```
## Environment
host arch, Docker version, date, base SHA of origin/main, Python + package pins,
TTM model id and revision, whether QSPIKE1's versions were recovered

## Results
| variant | builds? | uncompressed | compressed | cold build | warm rebuild |
| node ready (median / max) | py import | model load | 1-series | 1000-series | peak RSS |

## Delta
D − A and C − A and E(api) − A, for every column

## Against the D41 triggers
Trigger 4 only: the measured image and build delta, stated plainly.
Not a verdict. The threshold for "release cadence suffers" is not set (Question 2).

## Findings
anything that surprised you: musl, layer order, CUDA wheels pulled by accident,
a transitive dependency larger than torch
```

## 5. The decisions this feeds, and does not take

The report is evidence for three decisions. None of them is yours.

| Decision | Who | Read from |
|---|---|---|
| D41 trigger 4: is the scheduler split now, or later? | Deepak, against the threshold in Question 2 | D − A, warm rebuild, compressed size |
| Base image change, Alpine to glibc, for both services | Deepak | B's outcome, C − A |
| `torch` in a scheduler-only target (E), or in the shared image (D) | Deepak | E(api) − A versus D − A |

State the numbers, not a recommendation dressed as a measurement. If you have a
recommendation, put it under its own heading and label it as one.

## 6. Out of scope

- Any change to `src/`, migrations, the root `Dockerfile` or either `railway*.json`.
- Any Railway action. No `railway up`, `railway redeploy` or service creation, unless
  Question 1 is answered with a written, narrow exception.
- Forecast quality. That is QEVAL1.
- ONNX conversion of TTM. D35 settled that no export exists. Do not try to make one.
- Slimming `torch` (custom builds, stripping libraries). Measure the stock CPU wheel first.
  Slimming is a follow-up only if the numbers ask for it.
- Anything under `frontend/`.

## 7. Tests

No test is added. This task changes no behaviour. Two checks stand in for tests, and both
go in the report:

1. **Re-run `measure.sh` from a clean clone of the branch** and confirm it reproduces the
   size numbers. Sizes should match exactly for the same pins; timings within the spread
   you reported. A measurement that only reproduces on your laptop's cache is not one.
2. **Variant B's failure is attempted, not presumed.** The report quotes the actual
   install error, or reports that it succeeded and what it built from.

## 8. Done when

- `npm run build && npm run test:db` pass on the branch. The branch adds only
  `scripts/qml1-size/`, `docs/ai/measurements/QML1-SIZE.md` and this prompt, so the counts
  must equal the before-count. Take the before-count on a worktree off `origin/main`, naming
  the base SHA. A difference means something else came along.
- `npm run lint` passes. The encoding check covers `docs/`.
- Report: files created, the §4 table in full, host architecture, which timings are
  emulated, whether QSPIKE1's versions were recovered, and every assumption made.
- Commit and push the branch. Open the MR. Do not merge.

**One line for the task doc:** the model costs a quarter of a second, and this task finds
out what its dependency costs, because D41 says that number decides when forecasting gets
its own container.

---

## Questions — answer before starting

1. **Where are the representative timings taken?** Sizes are valid from any host.
   Cold-start timings are not valid from an emulated amd64 container on Apple Silicon.
   *Recommendation:* grant a written, narrow exception to create **one new** Railway service,
   `qml1-size`, deploy variant D to it with `railway up`, and read timings 6–9 from its logs.
   Under `CLAUDE.md`, creating a new service is safe by construction. The `railway up` needs
   the explicit grant. Deleting the service afterwards stays Deepak's. If no exception is
   granted, the report carries sizes and emulated timings only, labelled as such.
2. **What number counts as "release cadence suffers" for D41 trigger 4?** D41 says each
   trigger is "observable without judgement", but trigger 4 has no threshold, unlike the
   other three. *Recommendation:* set it after reading this report, as a compressed-size
   delta or a warm-rebuild delta, and record it as a dated addition to D41. This task does
   not choose it.
3. **Which Python package versions and TTM revision?** QSPIKE1's report is not on
   `origin/main`, and `1720281` is not reachable locally. *Recommendation:* if Deepak's
   laptop has the unpushed branch, push it or paste the pins. Otherwise pin current stable
   and record them. QML1 then inherits these pins.
4. **Is changing the base image from Alpine to glibc acceptable in principle?** It affects
   the api image too, unless E is adopted. *Recommendation:* measure first. This question
   only needs an answer before QML1, not before this task.
