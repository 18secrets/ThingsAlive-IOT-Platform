# QOEE1 — Performance, Quality and OEE

**Phase 2.** Do not start this during phase 1 closeout.

Read `CLAUDE.md` and `docs/ai/schema-inventory.md` first. Commit this prompt to
`docs/ai/prompts/` before writing code. Append the task to
`docs/ai/tasks/readiness-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/oee`

**Depends on:** QAVAIL1 (shipped — Availability), QPARAM1 (shipped — scoped parameters),
QSEED1 (bindings and telemetry to test against), and the library having loaded OEM values
per class. **If the OEM values are not in the library, stop and report — do not invent
defaults.**

---

## 0. Why this was held back

Availability shipped in phase 1 and is named Availability, not OEE. Performance and Quality
need a number per equipment class that only the OEM knows — nominal fuel consumption per
hour — and that number has to be authored across all 17 classes before any of this means
anything. **The blocker was never code.**

---

## 1. The three factors, and why they do not overlap

This is the part that is normally got wrong, so it is fixed here and nowhere else.

| Factor | Question | Denominator |
|---|---|---|
| **Availability** | Was the machine available during the shift? | scheduled minutes |
| **Performance** | While it was available, was it working? | **available minutes** |
| **Quality** | While it was working, did it work efficiently? | nominal fuel for the productive minutes |

**Performance's denominator is Availability's numerator.** That chain is the whole design:
each factor divides the slice the one above it handed down, so no minute is counted twice and

```
OEE = Availability × Performance × Quality
    = productive minutes ÷ scheduled minutes × quality
```

falls out without a separate calculation. Do not compute OEE any other way.

## 2. Performance — the idle-with-fuel breakdown

> **During a scheduled shift, a machine that is idle while it has fuel or power available,
> for longer than the threshold, is broken down.**

That is the definition. A machine with no fuel is not broken down — it is waiting on a
refuel, which is a different problem and not this task's.

**Detection is a virtual sensor**, the same mechanism as every other derived signal. It
reads two things the class already declares:

- the **running** signal — engine running, load, output, whatever the class names as its
  running indicator
- the **availability** signal — fuel level or power present

When running is below its idle bound **and** availability is present **and** the clock is
inside a scheduled shift, a candidate stoppage opens. When it has run longer than the
threshold, it becomes a **breakdown event**.

```sql
breakdown_event (
  id, tenant_id, source_system, external_id,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,          -- NULL while open
  duration_minutes  integer,              -- NULL while open
  shift_id,
  threshold_minutes integer NOT NULL,     -- the threshold in force when it was raised
  detected_from     jsonb NOT NULL,       -- the two signals and their values at open
  created_at
)
```

- **Events are derived and recomputable.** Never hand-edited. A replay over the same
  telemetry must produce the same rows.
- `threshold_minutes` is **stored on the row**, not looked up at read time. A client who
  changes the threshold tomorrow must not silently rewrite last month's history.
- An **open** event — still idle now — counts its minutes to now, and the widget says it is
  open. It is not excluded for being unfinished.

```
Performance = 1 − (breakdown minutes ÷ available minutes)
```

Floored at 0, never negative. If breakdown minutes exceed available minutes the detector is
wrong — **report it, do not clamp it quietly.**

## 3. Quality — fuel against its nominal

The client's own definition, carried verbatim: 6 litres an hour expected, 10 used, quality
is 60% and 40% is waste.

```
Quality = min(1, nominal fuel for the productive hours ÷ actual fuel consumed)
Waste   = 1 − Quality
```

- **Capped at 1.** A machine that beat its nominal is 100%, not 140%. OEE has no credit for
  outperforming a spec that was a guess.
- **Report `wasteFraction` and `wasteLitres` beside the value.** The waste is what a site
  manager acts on; the ratio is what rolls up. Giving only the ratio makes people compute the
  litres themselves and get it wrong.
- Nominal is per **productive** hour — Performance's numerator — not per scheduled hour. A
  machine that sat idle all day did not burn its nominal.
- **Dimension is unit.** The nominal and the telemetry are in the same unit or the KPI is
  refused. No conversion exists anywhere in this platform and none is added here.

## 4. Where the numbers come from

Two authors, four scopes, one resolution order.

**The library, per equipment class — OEM-provided:**

| | |
|---|---|
| `nominal_fuel_per_hour` | with its unit |
| `idle_breakdown_threshold_minutes` | **default 30** |
| the running signal and its idle bound | named from the class's own declared signals |
| the availability signal | likewise |

Refused at publish, naming what: a signal the class does not declare; a nominal with no
unit; a threshold below 5 minutes.

**The client, through QPARAM1's existing scopes — customer-entered.** Add to QPARAM1's
closed parameter name set:

```
nominal_fuel_per_hour
idle_breakdown_threshold_minutes
```

**Resolution order, most specific wins:**

```
equipment → equipment class (tenant copy) → site → client → library OEM default
```

**Surface it.** Every OEE response says which scope the value came from
(`parameterSource: 'equipment' | 'class' | 'site' | 'client' | 'oem'`). A client who
overrode a value at site level and forgot must be able to see that from the number.

The console path is **client administration → super admin → machine configuration**, and
**only the client super admin may write these** — the same rule as cost and currency.

## 5. Windows — day, week, month

Three windows, and one rule that matters more than the rest:

> **Sum the numerators and sum the denominators over the window. Never average the daily
> ratios.**

A day with 30 scheduled minutes and a day with 10 hours do not carry equal weight, and
averaging ratios says they do. This is the single most common OEE reporting defect; a test
asserts against it directly.

Partial windows report what they cover: a month queried on the 6th divides by six days of
scheduled minutes, and says `daysCovered: 6`. It does not extrapolate.

## 6. Absence is a state — the refusals

Every one of these returns `value: null` with its reason. **Never 1.0, never 100%, never a
factor quietly dropped from the product.**

| Condition | readiness | reason |
|---|---|---|
| no shift schedule for the window | `not_configured` | `no_shift_schedule` |
| the running or availability signal unbound | `not_configured` | `unbound` |
| `nominal_fuel_per_hour` set at no scope | `not_configured` | **`parameter_not_set`** |
| fuel signal bound but silent | `blocked` | `stale` |
| fewer scheduled minutes in the window than the threshold | `blocked` | `insufficient_coverage` |
| actual fuel consumed is zero over productive minutes | `blocked` | `undefined_result` |

**`parameter_not_set` is a new reason** — add it to the closed reason vocabulary and to
whatever test asserts that set is closed. Nothing existing says "the number exists in the
model but nobody has supplied it", and that will be the most common state for the first
year.

**OEE itself is null if any factor is null**, carrying the first blocking factor's reason.
A two-factor OEE is a different metric wearing the same name.

## 7. Endpoints

OEE is a KPI. It is served by the producers that already exist — **this task adds no page
endpoint and composes nothing.** QPAGE1's rule holds: one producer per number.

```
GET /api/v1/equipment/:sourceSystem/:externalId/oee?window=day|week|month&at=<date>
GET /api/v1/equipment/:sourceSystem/:externalId/breakdowns?from=&to=
```

```ts
{
  window: 'day' | 'week' | 'month',
  from, to, daysCovered,
  availability: { value, readiness, reason?, scheduledMinutes, availableMinutes },
  performance:  { value, readiness, reason?, breakdownMinutes, breakdownCount,
                  openBreakdown: boolean, thresholdMinutes, parameterSource },
  quality:      { value, readiness, reason?, nominalFuel, actualFuel, unit,
                  wasteFraction, wasteLitres, parameterSource },
  oee:          { value, readiness, reason? }
}
```

Site-level rollup follows QPAGE1's existing rule: aggregate only over machines whose own
value is `ready`, and report `machinesIncluded` / `machinesExcluded`.

## 8. Out of scope

- **Operator-entered stoppage reasons** — "why was it down" is a human input and a different
  task. The detector says *that* it stopped, never *why*.
- **Planned versus unplanned.** Everything idle-with-fuel inside a shift is unplanned here.
  Planned maintenance windows subtracting from scheduled time is a later refinement, and it
  needs the service schedule to be trustworthy first.
- **Production counts.** This platform has no part counter. Performance is time-based and
  Quality is fuel-based because that is what construction plant actually reports.
- Rewriting Availability. It shipped and it is correct.
- Anything under `frontend/`. Report the response shapes the console needs.

## 9. Tests

1. Idle with fuel for 45 minutes inside a shift, threshold 30 → one breakdown event of 45
   minutes.
2. Idle with fuel for 20 minutes → **no event**.
3. Idle with **no** fuel for two hours → no event. Assert this deliberately; it is the
   distinction the whole detector rests on.
4. Idle for 45 minutes **outside** any shift → no event.
5. A stoppage spanning a shift boundary → counted only for the scheduled part.
6. An open breakdown → counts to now, `openBreakdown: true`.
7. The threshold changes after an event was raised → the historical event keeps its own
   `threshold_minutes`; the value does not move.
8. 6 l/h nominal, 10 l/h actual → Quality 0.60, `wasteFraction` 0.40. **The client's own
   example; assert the exact numbers.**
9. 4 l/h actual against a 6 l/h nominal → Quality 1.0, not 1.5.
10. **Weekly OEE over a 30-minute day and a 10-hour day equals the summed-totals answer and
    not the mean of the two daily ratios.** Assert both and assert they differ.
11. A month queried mid-month → `daysCovered` is the elapsed days, no extrapolation.
12. No shift schedule → `no_shift_schedule`, all four values null.
13. No `nominal_fuel_per_hour` at any scope → `parameter_not_set`; **Availability and
    Performance still return their values**, OEE is null.
14. A nominal set at equipment and at client scope → equipment wins,
    `parameterSource: 'equipment'`.
15. Zero fuel consumed over productive minutes → `undefined_result`, not a divide-by-zero
    and not infinity.
16. Replaying the detector over unchanged telemetry produces identical events.
17. RLS: a tenant cannot read another tenant's breakdown events.

**Seed before you migrate.**

## 10. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Migration timestamp assigned immediately before the MR, after the last merge-in;
  `verify:migrations` clean; chain from empty; down path named.
- Report: commit SHA, test counts with base SHA, **which of the 17 classes have OEM nominals
  authored and which do not**, the cost of a month-window query over one machine and over a
  twenty-machine site, and anything not implemented with the reason.

**One line for the task doc:** OEE is three divisions chained so that each one's denominator
is the one above it's numerator — and the reason it is usually wrong is that somebody
averaged the ratios instead of summing the totals.
