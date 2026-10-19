# QML1-SIZE — what `torch` costs the scheduler image

Measured 19 October 2026 by `scripts/qml1-size/measure.sh` (every number below is in its
output; nothing is hand-copied from elsewhere). Sizes are valid from any host. **Every
timing is emulated, not representative**: amd64 images on an Apple Silicon laptop.

## Environment

- Host: arm64 (Apple Silicon), macOS (Darwin 25.6.0). Docker 29.9.0 client, 29.6.2 server;
  Docker Desktop VM with 8 CPUs and 3 GB usable memory.
- Builds for `linux/amd64`, run under emulation. Containers ran with `--cpus=8 --memory=3g`:
  the prompt's 8 GB could not be given, because the VM has 3 GB. D35's box was 8 cores, 8 GB.
- Base SHA of `origin/main`: `b06d7cf`. Measured from the branch at `1773a25`.
- Python 3.11.2 (Debian bookworm's), in a venv. Pins: `torch==2.11.0+cpu` (PyTorch CPU index),
  `granite-tsfm==0.3.9`, `transformers==5.19.0`, `numpy==2.4.6`, `huggingface-hub==2.2.0`;
  the full closure with hashes is `scripts/qml1-size/requirements.txt`.
- TTM: `ibm-granite/granite-timeseries-ttm-r2` at revision
  `d6a79570cac0f33d526601cd3a0fc7c80a8f9a2f` (main), context length 512; weights baked in,
  `HF_HUB_OFFLINE=1` at runtime.
- **QSPIKE1's versions were not recovered.** Commit `1720281` is on no remote and not on
  this machine. The pins above were compiled on 14 Oct (uv, `--universal --python-version
  3.11 --generate-hashes`) by an earlier attempt at this task and are used as they were.
- 5 runs per timed step; median / max reported.

## Results

| variant | builds? | on disk (uncompressed) | compressed (registry) | cold build | warm rebuild | torch layer rebuilt on src change |
|---|---|---|---|---|---|---|
| A — `node:22-alpine`, today's image | yes | 413 MB | 97 MB | 49.8 / 51.9 s | 19.6 / 23.5 s | – |
| B — A + python3 + torch (Alpine) | **fails** | – | – | – | – | – |
| C — glibc (`node:22-bookworm-slim`), no Python | yes | 479 MB | 117 MB | 75.5 / 163.3 s | 30.1 / 55.1 s | – |
| D — C + python3 + CPU torch + granite-tsfm + weights | yes | 2,235 MB | 605 MB | 299.2 / 459.3 s | 17.2 / 21.3 s | no |
| E — the api target of D's Dockerfile | yes | 479 MB | 117 MB | 61.2 / 81.7 s | 17.7 / 18.4 s | – |

| variant | node ready | py import | model load | 1-series | 1000-series | peak RSS |
|---|---|---|---|---|---|---|
| A | 2.45 / 2.58 s | – | – | – | – | – |
| C | 2.34 / 7.85 s | – | – | – | – | – |
| D | 2.26 / 17.69 s | 6.26 / 8.61 s | 0.144 / 0.214 s | 0.101 / 0.191 s | 0.657 / 0.760 s | 831 / 856 MB |
| E | 2.43 / 2.81 s | – | – | – | – | – |

Python process start-up before the first import: 0.199 / 0.248 s. 8 torch threads.
For comparison, D35 (Railway, 8 cores, 8 GB, native): 1000 series in 0.266 s, 568 MB peak.

## Delta

| delta | on disk | compressed | cold build (median) | warm rebuild (median) | node ready (median) |
|---|---|---|---|---|---|
| D − A | +1,822 MB | +508 MB | +249.4 s | −2.4 s | −0.19 s |
| C − A | +66 MB | +19 MB | +25.7 s | +10.5 s | −0.11 s |
| E(api) − A | +66 MB | +19 MB | +11.4 s | −1.9 s | −0.02 s |

Where D's size is (on disk, inside the image):

| size | path |
|---|---|
| 1,619 MB | `/opt/venv` — of which `torch` 749 MB, `pyarrow` 166 MB, `transformers` 119 MB, `scipy` 113 MB (+29 MB libs), `sympy` 79 MB, `pandas` 75 MB, `sklearn` 51 MB, `numpy` 45 MB (+27 MB libs) |
| 216 MB | `/app/node_modules` (the same production tree as C) |
| 145 MB | `/usr/local` (Node itself) |
| 80 MB | `/usr/lib` |
| 7 MB | `/app/dist` |
| 3 MB | `/opt/models` (TTM weights) |

## Against the D41 triggers

Trigger 4 only. Adding `torch` the way QML1 would ship it (D) makes the scheduler image
**+508 MB compressed** (97 → 605 MB, 6.2×) and **+1.8 GB on disk**, and a cold build
**+249 s** at the median (emulated). A normal release — a change under `src/` — does
**not** pay it: the warm rebuild of D is no slower than A's, because the Python layers sit
below the source copy and stayed cached in all five runs. Cold start of the Node process
is unchanged (2.3 s median against 2.5 s); the model is not loaded by Node.

Not a verdict. The threshold for "release cadence suffers" is not set (prompt Question 2).

## Findings

1. **Alpine is closed for this stack, and not because of musl.** `node:22-alpine` is now
   Alpine 3.24 with Python 3.14.8, and every `granite-tsfm` release requires Python below
   3.14. Variant B fails at `pip install` before `torch` is ever tried (the error is in
   `B.outcome` of the run and quoted below). So the musl question this variant was meant
   to answer was not reached; it was not worked around, as the prompt asks.
2. **A dependency of the forecaster costs a quarter of `torch`.** `granite-tsfm` brings
   `pyarrow` (166 MB), `scipy`, `pandas`, `scikit-learn` and `sympy`: about 560 MB beside
   `torch`'s 749 MB, none of it used for inference. Slimming was out of scope; this is
   where it would start.
3. **The inherited lock did not install as written.** In hash-checking mode pip
   re-resolved `granite-tsfm`'s `transformers[torch]` extra to a version the lock did not
   hold (5.20.1) and refused. The lock is the full closure, so the images install it with
   `--no-deps` and then run `pip check`, which fails the build if anything is missing. QML1
   should keep both.
4. **Moving off Alpine is cheap.** glibc without Python (C) is +19 MB compressed. And
   keeping `torch` out of the api (E) costs the api nothing beyond that: E equals C.
5. **No CUDA wheels came in.** `torch` resolved to `2.11.0+cpu` from the CPU index.
6. **First runs are slow, then not.** Node readiness on the first run after a build was
   17.7 s for D and 7.9 s for C, against about 2.3 s after; Python import ranged 4.8–12.6 s
   in probes before settling at a 6.3 s median. Both look like a cold page cache in the VM.
   Railway's first start after a deploy is that cold case.
7. **One warm rebuild of A took 0.7 s.** Its probe line matched one from an earlier smoke
   run, so the whole build was a cache hit. The script now makes each probe unique; the
   median is unaffected.
8. **Two measuring tools mislead under Docker Desktop's containerd store.**
   `image inspect .Size` reports the compressed size and `docker history` shows 0 B for
   locally built layers. The on-disk figures are measured inside each image (`du -sxk /`);
   the compressed figures are the layer sizes a local registry stored after `docker push`.

```
#12 [runtime 6/9] RUN /opt/venv/bin/pip install --no-cache-dir --no-deps --require-hashes -r /opt/requirements.txt  && /opt/venv/bin/pip check
#12 14.06 ERROR: Could not find a version that satisfies the requirement granite-tsfm==0.3.9 (from versions: 0.0.0)
#12 14.06 ERROR: No matching distribution found for granite-tsfm==0.3.9
(every listed release: Requires-Python >=3.9,<3.13 or >=3.11,<3.14; the image has 3.14.8)
```

## Checks

- **Reproduced from a clean clone** of `spike/qml1-size`: see the MR description for the
  size numbers of that run against the ones above.
- **Variant B was attempted, not presumed.** The error above is from the run.
- `test:db` on the branch: 81 suites, 922 tests — equal to `origin/main` at `b06d7cf`, as
  expected for a branch that adds only `scripts/qml1-size/`, this report and nothing else.

## Not done

- Representative timings. They need a Railway service (prompt Question 1), which needs a
  written exception. With one, `measure.sh`'s Python step runs unchanged inside it.
- The 8 GB memory limit: the Docker VM here has 3 GB.
