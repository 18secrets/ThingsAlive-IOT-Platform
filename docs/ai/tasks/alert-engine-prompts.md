# QALERT1 — alert evaluation becomes explicit

Read CLAUDE.md first; every rule in it applies.
Append the task to docs/ai/tasks/alert-engine-prompts.md (create it if absent).

Branch: git checkout main && git pull && git checkout -b feature/alert-evaluation

Three other branches are live: feature/calc-engine, feature/telemetry-partitioning,
feature/signal-freshness. If you need a migration, pick a timestamp above every
migration on main AND above 1758020000000, 1758040000000 and whatever
feature/signal-freshness took — check with the user rather than guessing.

feature/telemetry-partitioning is reshaping telemetry_reading. This task reads that
table. Write against the columns, not the physical shape, and add no indexes to it.

---

## The problem

SignalThresholdParams is { signal, min?, max? } and nothing else. Every reading is
compared on its own, so at 30-60s sampling a single noisy reading raises an alert.
There is no dwell time, no consecutive-reading requirement, no window.

## The decision (D34)

An alert rule is a set of stored parameters that a person can read back. Never free
text, never an expression.

  signal              the signal to watch
  min / max           the bound, as today
  lookback_readings   how many recent readings to consider - DEFAULT 10
  reduction           derived, not stored: max for an upper bound, min for a lower one

Take the last N readings by source_timestamp for that (imei, signal), reduce them to
one number, compare to the bound. At the platform's sampling rate, ten readings is
roughly a five to ten minute view - long enough to absorb a spike, short enough not
to delay a real excursion.

Where a rule sets both min and max, evaluate each independently against its own
reduction: max of the window against the upper bound, min of the window against the
lower one. Do not reduce once and compare twice.

## 1. Parameters

- Extend SignalThresholdParams with lookbackReadings?: number.
- SIGNAL_THRESHOLD_PARAM_KEYS is built as Record<keyof SignalThresholdParams, true>.
  Keep that construction - it is what stops the template drifting from the engine.
- Default 10, defined once in code, not as a literal at each use.
- Refuse lookbackReadings < 1 and > 1000 at write time.
- Unset means the default applies (D32: an unsupplied value is not a declaration).

If params are stored as jsonb, no migration is needed. If they are columns, add one.
Determine which and say so in the report rather than assuming.

## 2. The short-window rule

A window with fewer than 3 readings available does not fire, and records why.

Reason: on a newly commissioned machine the reduction over a single reading is that
reading, which reintroduces exactly the single-spike behaviour this task removes.
Three is the smallest number for which "the extreme of the window" means anything.

A window with between 3 and N readings evaluates over what is there.

## 3. Plain-English render-back

A function that turns a stored rule into one sentence:

  "Fires when the highest of the last 10 readings of coolant temperature rises
   above 105 degC."
  "Fires when the lowest of the last 10 readings of oil pressure falls below 2.5 bar."

Single sentence, the signal's display name, the unit, the reduction named in words.
QWF1 will reuse this, so put it where a workflow can import it - not inside a
controller.

## 4. No template change

The workbook column for lookback_readings lands with QREC0 in one v4 bump, alongside
the failure-mode and recommendation sheets. Until then every rule uses the default,
which is correct behaviour rather than a stopgap.

## 5. Tests

Each assertion is a test. Seed readings with explicit timestamps - never now()
arithmetic inside an assertion.

 1. Nine readings below 105, one spike at 120, lookback 10, max 105 -> FIRES
    (max of window is 120). This is the deliberate, correct behaviour for an upper
    bound: the window catches a spike, it does not hide it.
 2. Same data, but the spike is the 11th-most-recent reading -> does NOT fire.
    The window moved past it.
 3. Lower bound: one dip to 1.0, min 2.5, lookback 10 -> FIRES (min of window).
 4. Rule with both min and max, window containing one high spike and no low dip ->
    fires on the upper bound only, and the event names which bound.
 5. Two readings available, lookback 10 -> does NOT fire, and the skip reason is
    recorded.
 6. Five readings available, lookback 10, all above max -> FIRES (partial window
    is evaluated).
 7. lookbackReadings unset -> the default of 10 is applied. Assert the number
    actually used, not just that it fired.
 8. lookbackReadings = 0 is refused at write time. Also -1, and 1001.
 9. Readings for the same signal on a different imei do not enter the window.
10. The renderer produces the exact expected sentence for an upper bound, a lower
    bound, and a rule carrying both.
11. Every existing alert test still passes. If any of them encoded the
    one-reading-fires behaviour, that test was encoding the bug - update it and say
    which ones you changed and why.

## 6. Out of scope

- Template / workbook changes - QREC0.
- Time-based dwell ("above for 5 minutes"). Readings-based only. If you see a clean
  way to express time-based later, note it; do not build it.
- Any index on telemetry_reading.
- Anything under frontend/.

## 7. Done when

- npm run build clean, npm test and npm run test:db green. Report test counts before
  and after, measured by stashing back and running - not the summary line.
- Full migration chain runs from an empty database.
- Report back: commit SHA, test counts, whether a migration was needed, which
  existing tests you changed, and anything above you could not implement with the
  reason.


---

# Incident Management — the view, not the entity

Phase 1 ships **a view over what already exists**, not a new object.

```
GET /api/v1/incidents?status=open
```

Returns, per machine with an open alert: the machine, its open alerts, any open work orders
against it, and the worst severity among them. **No new table, no new lifecycle, no SLA
clock.** Acknowledging and resolving stay on the alert; assigning and completing stay on the
work order.

An incident **entity** — ownership, escalation, SLA timers — is phase 2, and only once
someone has used alerts in anger and can say what is missing. Designing that workflow now
means designing against no evidence.

## Recorded at implementation (2026-10-06)

- `GET /api/v1/incidents?status=open`, gated by `prediction.read` like the alert list it is built on.
  Any other `status` is a 400 — with no incident entity there is no closed incident to list.
- Worst severity is over the **alerts** only. Work orders carry a priority (low/normal/high/urgent), not
  a severity, and no mapping between the two has been decided; the priority is shown as it is.
- Work orders are included only for a caller holding `action.work`; otherwise `openWorkOrders: null`,
  never an empty list that would claim there are none.
- `AlertService.listEvents` gained `limit: null` (unbounded). The alert list keeps its 200 cap; an
  incident list cut at 200 would silently drop machines.
