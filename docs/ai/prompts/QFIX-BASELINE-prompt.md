# QFIX-BASELINE — the baseline mixes two populations

Read `CLAUDE.md` and `docs/ai/schema-inventory.md` first. Commit this prompt to
`docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b fix/baseline-population`

**Found by QSEED1.** Development had no telemetry, so no test could have caught this. The
seeder put 90 days of realistic readings in front of the baseline and it came back wrong.

---

## 0. The defect

Every machine's baseline KPIs swing about **±1.5σ daily**, healthy ones included.

The 30-day baseline window includes hours when the engine was running and hours when it was
parked. Those are **two populations, not one**. The mean lands between the clusters and σ is
inflated by the distance between them rather than describing variation within either. So:

- a normal machine reads as a daily excursion
- a real excursion is inside the same band as the noise
- **M-of-N (N=10, M=6) was tuned assuming unimodal noise**, and that assumption is false

A reading taken while the engine is running is being compared against a mean that includes
hours when it was off. No threshold over that comparison can be right.

## 1. The rule

> **A baseline is computed over operating periods only** — the same scheduled-and-running
> gate Availability already applies.

Readings outside operating periods are excluded from mean and σ. They are not deleted, not
zeroed, and not substituted.

**Reuse Availability's gate. Do not write a second one.** If it is not currently exposed in a
form the baseline can call, extract it — one definition of "running during a scheduled
shift", called by both. Two definitions of operating time is the `device_projection` versus
`device_inventory` defect again.

## 2. Measure before you change anything

**Report these first, from the seeded demo tenant, before writing the fix:**

1. mean and σ per baseline signal over the current 30-day window
2. the same over operating periods only
3. the daily z-score spread for EX-01 (healthy) under each
4. the same for EX-03 (breaching) under each
5. how many of EX-03's last 10 readings cross the bound under each

**If (3) does not narrow and (4) does not separate from (3), the diagnosis is wrong — stop
and report.** My last two diagnoses of this kind were both wrong and the measurements were
right.

## 3. Coverage — the new refusal

Excluding parked hours removes readings, and some machines will no longer have enough.

A baseline needs a **minimum of operating-period readings** across a minimum number of
**distinct days** before it means anything. Choose both from the measurements in §2, state
them in the report with the reasoning, and put them in one named constant — not scattered
literals.

Below either: `blocked` / `insufficient_coverage`, **value null**. Never a baseline computed
from four hours of data, and never a silent fall back to the unfiltered window — that is the
defect wearing a disguise.

`baseline_not_established` keeps its existing meaning: not enough elapsed history.
`insufficient_coverage` is: enough history, not enough of it operating.

## 4. Re-tune M-of-N, or justify leaving it

N=10, M=6 was chosen against the inflated σ. Once σ describes one population, it may be
wrong in either direction.

**Measure, then decide, then report the numbers behind the decision.** Leaving it at 10/6 is
a valid answer if the measurements support it; leaving it because it is already there is not.

## 5. Out of scope

- The alert engine's structure. Only its threshold inputs are in question.
- Prediction and forecasting. Report whether they read the same baseline — if they do, say
  so; it is a follow-up, not this branch.
- Changing what counts as a scheduled shift.
- Anything under `frontend/`.

## 6. Tests

1. A machine with parked hours in its window → mean and σ computed from operating readings
   only. Assert the excluded readings exist and were excluded.
2. **EX-01 healthy → no daily excursion.** This is the defect; write it deliberately.
3. EX-03 breaching → still breaches, and by a wider margin than EX-01's noise.
4. A machine with 30 days of history but almost no operating hours → `blocked` /
   `insufficient_coverage`, value null.
5. A machine with 9 days → `baseline_not_established`, unchanged.
6. A machine with zero operating readings → `insufficient_coverage`, **not** a divide by zero
   and not σ of 0.
7. σ of 0 over valid operating readings → `undefined_result`, unchanged.
8. Availability and the baseline agree on which minutes were operating. Read both and assert
   it — one definition, two callers.
9. Any QSEED1 test marked pending against this task → unmarked and passing.

**Seed before you migrate.**

## 7. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Report: commit SHA, test counts with base SHA, **the §2 measurements in full**, the two
  coverage minimums and why, the M-of-N decision with its numbers, whether prediction reads
  the same baseline, and anything not implemented with the reason.

**One line for the task doc:** the baseline was averaging a running machine and a parked one
together and calling the gap between them noise — and it took seeded telemetry to see it,
because an empty database makes every statistic look fine.
