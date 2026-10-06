# QAVAIL1 — availability, uptime and downtime

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/utilization-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/availability`

**Stream B.** Touches `src/utilization` and `src/shift` only. Assign the migration timestamp
**at rebase time** if one is needed — probably none.

---

## 0. Why this is its own task, and why it is not called OEE

The Command Center shows **Uptime hours**, **Downtime hours** and **OEE (week)**. None of
them has a backend. The figures on screen are sample data.

**OEE is availability × performance × quality.**

| Factor | Computable today? |
|---|---|
| Availability | **yes** — runtime versus scheduled time, from shifts and utilisation |
| Performance | **no** — needs units produced versus rated output. No sensor reports it |
| Quality | **no** — needs good units versus total. Nothing in telemetry knows about quality |

So this task delivers **Availability**, named Availability. **Do not label it OEE.** A
customer who compares a number called OEE against their own will find it wrong, and will then
stop trusting every other number on the page.

---

## 1. The definitions — agreed, and they go in the code as comments

These are the decisions. Put each one beside its implementation so the next person does not
re-derive it.

| Term | Definition |
|---|---|
| **Scheduled hours** | the sum of the machine's shift windows in the period. A machine with no shift defined has **no** scheduled hours |
| **Uptime hours** | hours inside scheduled windows where the machine was running — the existing running-status determination, unchanged |
| **Downtime hours** | scheduled hours **minus** uptime hours. Not wall-clock, not idle-outside-shift |
| **Availability** | uptime ÷ scheduled, as a ratio |

**Running outside a shift window counts toward neither.** It is unscheduled work; counting it
as uptime makes availability exceed 100% and the number becomes nonsense. Report it
separately as `unscheduledRunningHours` so it is visible rather than discarded.

## 2. No shifts means no number

A machine with no shift schedule has no scheduled hours, so availability is undefined.

**Return `not_configured` with reason `no_shift_schedule`.** Not 0%, not 100%, not null
silently. Same rule as everywhere: the absence is a state.

This will be the common case at first — `SHIFT_RUNNER_ENABLED` is on, but few machines have
shifts defined. The screen must say "no shift schedule" rather than showing a zero.

## 3. Endpoints

```
GET /api/v1/utilization/availability?from=&to=                 fleet summary
GET /api/v1/utilization/availability/:sourceSystem/:externalId one machine
```

Response, per machine or aggregated:

```
{ scheduledHours, uptimeHours, downtimeHours, unscheduledRunningHours,
  availability: number | null,
  readiness: 'ready' | 'not_configured' | 'not_available',
  reason?: 'no_shift_schedule' | 'no_readings' }
```

`availability` is **null** whenever `readiness !== 'ready'`. The same envelope discipline as
QCE2 — a caller that ignores readiness gets null and fails loudly.

Fleet aggregation sums the hours of machines that **have** a schedule and reports how many
were excluded for not having one. An average over machines that could not be measured is a
fabricated number.

## 4. Tests

1. A machine with shifts and full running coverage → availability 1.0.
2. Half the scheduled window running → 0.5, and downtime equals half the scheduled hours.
3. Running outside the shift window → counted in `unscheduledRunningHours`, **not** uptime,
   and availability does not exceed 1.0.
4. A machine with no shift schedule → `not_configured` / `no_shift_schedule`,
   `availability: null`.
5. A machine with a schedule but no telemetry in the period → `not_available` / `no_readings`,
   `availability: null`, **not 0**.
6. Fleet summary over three machines, one without a schedule → the sum covers two, and the
   excluded count is reported.
7. A period boundary that cuts a shift in half → only the part inside the period counts.

## 5. Out of scope

- **OEE.** Performance and quality have no data source; that is a product decision, not a
  task. Do not add placeholder columns for them.
- Manual production entry — a later task if the decision goes that way.
- Anything under `frontend/`. Report the response shape.

## 6. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  **worktree off `origin/main`**, naming the base SHA.
- Report: commit SHA, test counts with base SHA, how many machines in Development currently
  have a shift schedule (this decides whether the tile is useful yet), and anything not
  implemented.
