# ITDC Telemetry — Use Case Map

Transcribed from `itdc telemetry usecases_4665_0514.pdf`, 2026-09-30. Content unchanged.

Based on fields already parsed and stored per device: `latitude`, `longitude`,
`gsm_signal_strength`, `fuel_level`, `fuel_consumption`, `engine_coolant_temperature`,
`engine_oil_pressure`, `engine_oil_temperature`, `torque`, `throttle_position`,
`engine_load`, `ignition_status`, `engine_running_status`, `utilization_status`,
`engine_runtime`, `hydraulic_oil_temperature`, `serial_number`.

Six months of history is enough for anything that trends over weeks (drift, ratios, service
intervals). It is not enough for a trained failure-classifier — that needs 12–18 months plus
labeled failure events. Everything below is achievable now as rules or drift detection, no
labels required.

---

## 1. Predictive Maintenance

| Use case | Fields used | Logic |
|---|---|---|
| **Overheating / cooling degradation** | `engine_coolant_temperature`, `hydraulic_oil_temperature`, `engine_load` | Rolling 7-day avg temp-at-load vs. 90-day baseline, per device |
| **Oil system health** | `engine_oil_pressure`, `engine_oil_temperature`, `engine_runtime`, `engine_load` | Pressure sagging at a given load band vs. baseline; oil temp rising independent of coolant temp |
| **Fuel efficiency drift** | `fuel_consumption`, `engine_runtime`, `engine_load` | Fuel-per-hour or fuel-per-load ratio rising over time |
| **Load/throttle mismatch** | `throttle_position`, `engine_load`, `torque` | Throttle needed for same load increasing = growing mechanical resistance |
| **Hour-based service prediction** | `engine_runtime` | Predict next service date/hours per machine; flag machines hitting intervals faster than fleet average |
| **Duty-cycle / idling stress** | `ignition_status`, `engine_running_status`, `utilization_status` | Idle-time ratio, start/stop cycle counts vs. own baseline |
| **Cross-sensor anomaly / risk score** | all of the above, combined | Per-device z-score against its own 90-day baseline for each signal; sum into one risk score. Machine tripping 3+ signals at once = high priority |

**Output:** ranked device list — device ID, which signals are elevated, how long trending,
days since last service. No trained model needed for v1.

## 2. Fuel Theft / Pilferage Detection

`fuel_level` drop + `ignition_status` off + no GPS movement (`latitude` / `longitude`
unchanged) in a short window. Direct rule, no baseline needed. Highest ROI for
construction/genset fleets.

## 3. Utilization / Asset Productivity Reporting

`ignition_status` + `engine_running_status` + `utilization_status` + `engine_runtime` →
productive vs. idle vs. off hours per machine/shift/site. Feeds rental billing and "which
assets are earning their keep."

## 4. Operator Behavior Scoring

`throttle_position`, `engine_load`, `torque`, idle time per operator/shift. Same
load/throttle ratio as PdM, different lens — harsh usage, excessive idling, inefficient
operation.

## 5. Geofencing / Unauthorized Movement

`latitude` / `longitude` vs. defined site boundaries, combined with `ignition_status`. Flags
theft risk, after-hours use, unauthorized relocation.

## 6. Fleet Efficiency Benchmarking

`fuel_consumption` / `engine_runtime` ratio compared across machines/models/sites — not for
fault detection, for procurement and cost-per-hour decisions.

## 7. Emissions / Sustainability Reporting

`fuel_consumption` → estimated CO₂ per machine/site/month. Direct multiplier on existing
data, increasingly required in ESG reporting for construction/logistics clients.

## 8. Device/Connectivity Health

`gsm_signal_strength`, gaps in `serial_number` sequence, packet arrival timing → which
devices are flaky (poor signal zones, dropped connections, spool replay backlogs). Not
equipment PdM — fleet-of-devices health — but affects data quality for every other use case
above.

## 9. Warranty / SLA Support

`engine_coolant_temperature`, `engine_oil_pressure`, `engine_runtime` history as an audit
trail — was a failure caused by misuse (outside normal load/temp bounds) or a genuine
defect. Useful if selling through OEM/dealer channels.

---

## Suggested build order

1. **Fuel theft detection** — pure rule, immediate value, no modeling
2. **Utilization reporting** — pure aggregation, direct revenue insight
3. **PdM risk score (drift-based)** — needs 90-day rolling baseline per device, ships without failure labels
4. **Geofencing** — pure rule, needs site boundary definitions
5. **Operator scoring, benchmarking, emissions, warranty audit trail** — reporting-layer extensions once 1–3 are live
6. **Device connectivity health** — background/ops dashboard, supports data quality for everything else

Cases 1, 2, 4, and the fuel-theft/utilization pieces of 3 map directly onto the alarm rule
engine's workflow JSON (rate-of-change and ratio conditions). The cross-sensor risk score
(case 7 under PdM) is a natural fit for the "reuse and learn" cached-pattern workflow once
it's tuned against real technician interventions.
