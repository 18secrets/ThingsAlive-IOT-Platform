# QSPIKE1b — the host check (§1), before the one attempt

Measured 20 October 2026. This report covers **§1 of the prompt only**: what the Railway
host offers a CPU inference runtime. The one attempt (§2) has not run, because it needs a
throwaway Railway service and that is not granted yet (prompt, question 2). Nothing in this
report was built, installed or deployed; the check read `/proc` and the cgroup files of a
running container and nothing else.

## Verdict

**Not yet attempted.** The prompt's early exit (*host cannot: no AVX2*) does **not** apply:
the host has AVX2, FMA and AVX-512. The build-flag hypothesis survives, and §1 surfaced a
second one that is cheaper to test (below).

## Host

Read from the `scheduler` service, Development environment, by `railway ssh` into its
running deployment:

```
railway ssh --service scheduler --environment Development -- sh -c '
  grep -m1 "model name" /proc/cpuinfo; nproc;
  cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max 2>/dev/null;
  F=$(grep -m1 ^flags /proc/cpuinfo);
  for x in avx avx2 fma f16c avx512f avx512_vnni avx_vnni; do
    case " $F " in *" $x "*) echo "$x yes";; *) echo "$x NO";; esac; done'
```

| | |
|---|---|
| CPU | AMD EPYC 9655 96-Core Processor (Zen 5) |
| `avx`, `avx2`, `fma`, `f16c` | all present |
| `avx512f`, `avx512_vnni`, `avx_vnni` | all present |
| `nproc` (what the process sees) | **48** |
| `cpu.max` (what the cgroup allows) | `2400000 100000` = **24 CPUs** |
| `memory.max` | 24,000,000,000 bytes = **24 GB** |

This is the `scheduler` container, not the service QSPIKE1 ran in. Railway places
deployments on whatever host it has, so QSPIKE1's host CPU is unknown; nothing here
says it was the same machine.

## Two things this changes

**1. The limits are not D35's.** D35 records 8 cgroup cores and 8 GB "consistent across two
deployments". The scheduler today has 24 and 24 GB. Railway limits are set per service, so
QSPIKE1's service may simply have been configured smaller; either way, D35's limits
describe that service, not every container in the project. A spike service must record its
own `cpu.max` and `memory.max` before it runs anything.

**2. `nproc` reports twice what the cgroup allows — a second hypothesis.** A runtime that
sizes its thread pool from the visible core count will start more threads than it is
allowed CPU for. llama.cpp's worker threads spin while they wait for each other, so
over-subscription under a CFS quota does not degrade gracefully: the threads that are
throttled hold up the ones that are spinning, every layer, every token. `llama-cpp-python`
defaults `n_threads` to half of `multiprocessing.cpu_count()`, which reads the visible
count, not the quota. If QSPIKE1's host also showed 48 cores against its 8-core quota, that
default was 24 threads on 8 CPUs. "Hours, no completed inference, memory to spare" fits that
at least as well as a missing instruction set. **This is a hypothesis, not a finding.**
QSPIKE1's thread count was not recorded.

## What the one attempt should now be

The prompt's §2 changes one variable, the build. There are now two candidate variables, and
they can still be separated inside one attempt without becoming two. `scripts/qspike1b/`
builds **one image** holding the same llama.cpp commit (`b6000`, `4762ad7`) twice, native
detection off in both:

- `generic`: AVX, AVX2, FMA, F16C and AVX-512 all off, the shape of a lowest-common wheel
- `isa`: exactly the flags in the Host table

and runs Qwen3-4B Q4_K_M (official Qwen GGUF, sha256 `7485fe6f…34fdf5`) in this order, each
inference under a 30-minute timeout:

| run | build | threads | answers |
|---|---|---|---|
| 1–3 | isa | the cgroup quota | does the 4B complete at all, and how fast |
| 4–6 | generic | the cgroup quota | what the instruction set is worth, threads held fixed |
| 7 | isa | 3 × quota | what over-subscription costs, build held fixed |
| 8 | generic | 3 × quota | QSPIKE1's suspected condition (24 threads on 8 CPUs is 3 ×) |

Every line the report needs starts with `QSPIKE1b` in the service's log, including a
progress line each minute so a timeout shows whether anything was generated. The service
exits when done and `restartPolicyType: NEVER` keeps it from running again. Worst case,
every run times out: about 4 hours of 24 vCPUs.

This is not QSPIKE1's harness (still unpushed), so it is not the same runtime build; it
is the same model size and quantisation.

Deploy, from `scripts/qspike1b/`, after linking that directory to the Development
environment:

```
railway add --service qspike1b
railway up --service qspike1b --environment Development --detach
railway logs --service qspike1b --environment Development | grep QSPIKE1b
``` Neither touches the
`scheduler`: running the spike there would take its CPU from the forecast, escalation-sweep
and outbox jobs, and would mean changing its image.

## Spend

$0. One `railway ssh` session that read files; no service created, nothing deployed.

## Time

Under a minute of wall-clock. The one-day budget has not started; it starts at the first
command of §2.

## Still needed before §2

- Written grant of one new `qspike1b` service in Development, and `railway up` to that
  service only, no variable changes on any existing service (prompt, question 2).
- A per-inference timeout and a spend cap (questions 3 and 4).
- QSPIKE1's harness and exact GGUF file (question 5). Commit `1720281` is still on no
  remote. Without it, step 1 above cannot reproduce QSPIKE1's runtime version exactly, and
  the report must say so.

## What this changes

Nothing is decided here. D36's flag stays off and QREC2 ships templates either way. What
this check adds: the host can run every instruction set a CPU build would ask for, and the
original failure has a cheaper explanation worth ruling out first.
