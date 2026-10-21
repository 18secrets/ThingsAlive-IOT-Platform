# ITDC use cases vs. Platform 2.0 — what's covered, what's missing

Against the backend on `main`, decisions D01–D41, and the task register. 2026-09-30.

**Headline: three of the nine are already built. The predictive-maintenance section needs
one addition to the formula operator set, not a model. Three capabilities are genuinely
absent from the data model.**

---

## 1. Coverage

| | Use case | Status | What it needs |
|---|---|---|---|
| 1 | Predictive maintenance (7 sub-cases) | **partial** | baseline operators (§3), QCE2, and for two sub-cases QML1 |
| 2 | Fuel theft / pilferage | **built** — `1757830000000-FuelLossTrigger`, P4-04 | geospatial for the "no movement" clause (§4) |
| 3 | Utilization / productivity | **built** — `1757840000000-Utilization`, P4-05 | categorical signals to be exact (§4) |
| 4 | Operator behaviour scoring | **absent** | an operator dimension — the platform has no concept of who was driving |
| 5 | Geofencing | **deferred** — P4-06 | geospatial types and site boundaries (§4) |
| 6 | Fleet benchmarking | **partial** | cross-machine aggregation; the site class (D30 part 3) is the right home |
| 7 | Emissions / CO₂ | **easy** | one formula, `fuel_consumption × factor`. A published library KPI, nothing new |
| 8 | Device / connectivity health | **built** — `1757860000000-DeviceLinkHealth`, P4-08 | — |
| 9 | Warranty / SLA audit trail | **conflicts with retention** (§5) | archived telemetry must stay queryable |

Hour-based service prediction (case 1, sub-case 5) is also already built — P4-07.

---

## 2. The important structural finding: most of this needs no ML

Every logic column in section 1 is one of two shapes:

- **a ratio or normalisation** — temperature *at a given load*, pressure *at a load band*,
  fuel *per hour per load*, throttle *for the same load*
- **a comparison against the machine's own recent history** — rolling 7-day vs 90-day
  baseline, per-device z-score

The first is exactly what the formula engine is for: compute the ratio as a **series-valued
formula** (`result_kind = 'series'`, already supported by QCE1), and the noise from varying
load disappears. `fuel_consumption / engine_runtime`, `throttle_position / engine_load`,
`engine_coolant_temperature` conditioned on load band — all compositions over the registry.

The second is a **rolling baseline**, which is arithmetic, not a model.

So ITDC's entire predictive-maintenance section is deliverable **before QML1**, on the
deterministic layer alone. That matters for sequencing: it means real predictive value ships
earlier than the forecasting work, and QML1 becomes an upgrade rather than a precondition.

The document says the same thing in its own words — *"no trained model needed for v1"*.

---

## 3. The one change that unlocks section 1

**The alert engine cannot express "compared to its own baseline".** D34 compares a signal to
a fixed threshold over a window of readings. Nothing in the stack says "versus this
machine's last 90 days".

Add **baseline operators to the formula registry** (QCE3), rather than a new rule kind:

```
baseline_avg(series, window)     mean over a trailing window, excluding the current period
baseline_sd(series, window)      standard deviation over the same
zscore(series, window)           (current − baseline_avg) / baseline_sd
delta_ratio(series, w1, w2)      mean over w1 ÷ mean over w2   — the 7-day vs 90-day shape
```

Then every row of section 1 becomes a published library KPI with an ordinary threshold rule
on it, and the cross-sensor risk score is arithmetic over several z-scores with a count of
how many exceed 2. No new engine, no new rule type, and it reuses the compiler, the unit
checking and the readiness states already built.

**Two things to get right:**

- A baseline needs a minimum history or it is noise. Same rule as D20:
  **`baseline_not_established`** below 14 days, shown as its own state, never as "normal".
- A baseline learned while the machine was already degrading encodes the fault as normal.
  Exclude periods with a raised alert or an open work order — D20 already says this for
  residual bands; it applies identically here.

---

## 4. Three capabilities genuinely absent from the data model

### 4a. Categorical signals

`ignition_status`, `engine_running_status`, `utilization_status` are **states, not numbers**.
`telemetry_reading.value` is `double precision`, and every operator in the registry is a
numeric aggregation.

Booleans survive as 0/1, awkwardly. An enumerated `utilization_status` does not. And the
operators these use cases need are different in kind:

```
fraction_in_state(series, state)    idle-time ratio
transitions(series, from, to)       start/stop cycle counts
dwell_in_state(series, state)       longest continuous run
```

Utilisation, duty-cycle stress, idling and the "ignition off" clause of fuel theft all
depend on this. Worth a task of its own: **QCAT1 — categorical signals and their operators.**

### 4b. Geospatial

`latitude` / `longitude` are stored as two numeric signals today, which is enough to detect
"unchanged" but not to answer "inside the boundary". Geofencing needs a point type, boundary
polygons per site, and an inside/outside operator. P4-06 correctly defers this until there
is a boundary to fence — but note that **fuel theft's strongest clause depends on it**, and
that case is ranked first in ITDC's own build order.

### 4c. An operator dimension

Case 4 scores behaviour *per operator per shift*. The platform has machines, shifts and
users, but nothing links a person to a shift on a machine. Without that, operator scoring
cannot be computed at all — it is not a reporting gap, it is a missing entity.

Decide whether operator attribution is in scope before promising case 4 to anyone.

---

## 5. Warranty evidence conflicts with the retention policy

Case 9 is an **audit trail**: was this failure caused by misuse? That question is asked
months or years after the event, by an OEM or a dealer, about a specific machine.

D14 and D24 set 90 days hot, then Parquet archive. That is right for cost. But it means
**warranty evidence lives in the archive**, and an archive nobody can query is not evidence.

QARCH1 must therefore support a bounded, slow, on-demand read path: "reconstruct
`engine_coolant_temperature` and `engine_oil_pressure` for machine X between these dates".
Not a live query path, and not something a dashboard hits — an export that takes minutes and
produces a defensible record.

If that is not built, case 9 is not deliverable at any retention setting we can afford.

---

## 6. Signal naming — a mapping problem we already have the mechanism for

ITDC's names and the platform's do not match:

| ITDC | Platform / demo |
|---|---|
| `engine_coolant_temperature` | `coolant_temperature` |
| `engine_oil_temperature` | `oil_temperature` |
| `engine_oil_pressure` | `oil_pressure` |
| `hydraulic_oil_temperature` | `hydraulic_temperature` |
| `throttle_position` | `throttle` |

`signal_alias` exists (migration `1757680000000-Catalog`) for exactly this. The rule is the
one already in the data-pipeline note: **the connector maps external IDs to the platform
library and normalises units before ingestion**. Nothing downstream should ever see two names
for one measurement — rule binding is by `(signal, unit)`, and a name drift silently unbinds
every rule that referenced it.

Also absent from the platform's vocabulary and needing catalog entries: `fuel_consumption`,
`torque`, `gsm_signal_strength`, `serial_number`.

---

## 7. What I would add to the plan

| | Task | Why |
|---|---|---|
| **QCE4** | Baseline operators — `baseline_avg`, `baseline_sd`, `zscore`, `delta_ratio`, with `baseline_not_established` and dirty-window exclusion | unlocks the whole of ITDC section 1 without a model |
| **QCAT1** | Categorical signals and their operators | utilisation, duty cycle, idling, and fuel theft's ignition clause |
| **QARCH1** *(scope addition)* | A bounded on-demand read path over archived telemetry | case 9 is undeliverable without it |
| **QGEO1** | Geospatial signals, site boundaries, inside/outside | case 5, and fuel theft's movement clause |
| *decision* | Is operator attribution in scope? | case 4 is a missing entity, not a missing report |

**Sequencing note.** QCE4 is small — four operators on an existing registry — and it turns
seven ITDC use cases from "needs ML" into "needs a published KPI". It is the highest
value-per-day item on the board right now, and it can run immediately after QCE3.
