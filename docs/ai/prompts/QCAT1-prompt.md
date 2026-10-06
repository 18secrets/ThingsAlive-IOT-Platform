# QCAT1 — categorical signals and their operators

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `feature/categorical-signals`, stacked on QGRANT1 (!67) — merge after it.

**Stream B.** Touches `src/catalog/formula/`, the evaluator's plan walk, publish in
`catalog-authoring.service.ts`, and a new vocabulary in `src/device-catalog`. Append to
`operator-registry.ts`, never reorder. Nothing under `src/catalog-import/`.

Drafted at the user's instruction from `docs/ai/analysis/itdc-coverage-analysis.md` §4a.
The user chose numeric codes plus a vocabulary over a text column on `telemetry_reading`.

---

## 0. Why

`ignition_status`, `engine_running_status` and `utilization_status` are states, not numbers.
Every registry operator is a numeric aggregation, so utilisation, duty-cycle stress, idling and
fuel theft's "ignition off" clause cannot be expressed.

## 1. Storage — codes stay numeric

`telemetry_reading.value` is unchanged: a state arrives as its code. A new platform table says
what the codes mean:

```sql
signal_state (
  measurement_role text, state text, code int,
  PRIMARY KEY (measurement_role, state),
  UNIQUE (measurement_role, code)
)
```

- `state` matches `^[a-z][a-z0-9_]*$`; `code` is a whole number ≥ 0.
- Platform-owned reference data, like `sensor_role_capability`: no `tenant_id`. Read with
  `device-catalog.read`, written with `device-catalog.write`.
- `GET /api/v1/device-catalog/signal-states?role=` and
  `PUT /api/v1/device-catalog/signal-states/:role` (replace the role's whole vocabulary).

## 2. Grammar — a state is a quoted name

`'idle'` is a new literal, allowed **only** as an operator's state argument. Anywhere else —
arithmetic, a comparison, a root — it is refused: a state is a label, not a number.

## 3. Operators

| operator | result | meaning |
|---|---|---|
| `fraction_in_state(s, 'state')` | dimensionless | share of time in the state |
| `transitions(s, 'from', 'to')` | dimensionless | count of from → to changes |
| `dwell_in_state(s, 'state')` | hours | longest continuous run in the state |

**Time-weighted, as a step function.** A reading's state holds until the next reading; the
last holds until the window's end; time before the first reading in the window is unknown and
not counted. A sample-count fraction would make a machine that reports more often while
working look busier than it was.

No readings in the window is `no_readings`, never 0.

## 4. Codes are resolved at publish

The compiler takes an optional vocabulary. Given one, it resolves each state name to its code
and embeds the code in the plan, refusing an unknown state (listing the known ones) or a
signal with no vocabulary. Without one — the import dry-run, which has no database — the name
is kept and the code left empty.

`publishClass` always passes the vocabulary for the class's signals, so a published plan
always carries codes. Changing the vocabulary later cannot change a published or copied KPI's
meaning. A plan with an unresolved code reads `not_configured`, never a guessed state.

## 5. Out of scope

- A text value column on `telemetry_reading` — rejected (§0 of the user's decision).
- Categorical alert rules, and the import workbook's vocabulary sheet — Builder A's area.
- Geospatial — QGEO1.

## 6. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after naming the
base SHA. Migration timestamp above `main`; down path named with `undoMigrationNamed`.
