# TMCV engine cold test: raw ingestion and prediction outcome schema (draft)

Source: `TMCV-Engine-Things-Alive-Deck.pptx`, UC-1 to UC-7. This is a draft for discussion.
Nothing has been migrated. Assumptions are marked **[A]**, and questions for TMCV are listed at the end.

---

## 1. What the request means

The deck promises seven predictions. Every one of them depends on two contracts that do not exist yet:

1. **Raw ingestion schema.** This is the shape data has when it arrives from the bench: PLC signals, the new
   sensors (accelerometers, microphone, RTDs, CTs, encoder), and the engine-test context (serial number,
   variant, cycle, stage, PLC pass/fail). It answers the question: what do we store, at what resolution,
   and how is it keyed?
2. **Prediction outcome schema.** This is the shape of what the platform produces: a verdict, an anomaly, a
   leak rate, a RUL or an OEE figure. It also has to record which model produced the output, from what
   evidence, at what point in the cycle, and what was done about it. Later the outcome is joined to the
   confirmed result so the prediction can be scored.

The central difference from today's platform is this. 2.0 models **scalar telemetry**: one value per
signal every 30 to 60 seconds, scored on shift boundaries (D12). An engine cold test is a **discrete
event**: one engine, one cycle of 2 to 5 minutes **[A]**, with high-rate waveforms. So the main thing the
schema adds is the **test cycle** as a first-class row that everything else hangs off.

## 2. Is it possible?

**Yes, the schema can be designed now.** Not every use case can be delivered the way the deck words it.

| UC | What it needs | Fits today's platform? | Verdict |
|---|---|---|---|
| UC-1 early pass/fail | Mid-cycle verdict within seconds, plus labelled history per variant | **No** for in-loop: cloud scoring is batch (D12). **Yes** for shadow mode | Possible as shadow mode in the platform. In-loop needs **inference on the edge gateway** and TMCV quality sign-off, because a wrong early PASS is an escape |
| UC-2 torque signature | Crank-angle-resolved torque waveform per cycle, per-variant baseline | Waveforms can't go in `telemetry_reading` | Possible with a waveform store. Fault-class labels must come from TMCV teardown/rework data, never invented (G07) |
| UC-3 spindle load | Motor current, vibration and temperature trends on the rig | Mostly yes (scalar trends) | Possible. Separating rig faults from engine faults needs rig and engine sensors on the same clock |
| UC-4 sensor self-test | Per-cycle rules: cam↔crank correlation, RPM vs commanded, temperature drift | Yes. These are deterministic Tier 0/1 rules | **Most feasible.** Good first deliverable |
| UC-5 noise / leak | Acoustic burst plus pressure-decay curve | Needs a waveform store | Leak rate from a decay-curve fit is physics, so it's feasible. NVH anomaly needs labelled escapes |
| UC-6 bench RUL | Run-to-failure history of bearings and motors | Trend thresholds yes, RUL number no | Start with Tier 0/1 health trends. **No RUL hours until there's failure evidence** (G07) |
| UC-7 OEE / alarms | Bench states, PLC alarms, cycle counts | Yes | Possible. Quality factor = PLC result first, UC-1 only once validated |

**Three decisions need an owner before any build:**

1. **Where does bench data land?** D01/G05 say raw telemetry stays upstream in 1.0. But the 1.0 store is
   `(device_sensor_measurement_id, timestamp, value)`. It can't hold cycles, serial numbers or waveforms.
   Either 2.0 ingests TMCV directly (from the edge gateway over MQTT/HTTPS), or 1.0 is extended. This is an
   architecture decision for DECISIONS.md, not a schema detail.
2. **Volume.** One tri-axial accelerometer at 25.6 kHz with float32 samples is about 300 KB/s, so about
   55 MB per 3-minute cycle **[A]**. With 4 accelerometers and a mic, that's roughly 150 to 250 MB per
   cycle, and tens of GB per bench per day. The proposal is that the edge computes features for every
   cycle, and raw bursts are uploaded only in the test window and kept for a sample plus every flagged
   cycle (the deck already says "burst capture only in the test window").
3. **Labels.** The PLC pass/fail is not the truth for training or for counting escapes. We need the
   **confirmed** outcome from teardown, rework, MES/QMS or warranty. Without it, UC-1, UC-2 and UC-5 can
   run in shadow mode but can't be validated.

---

## 3. Raw ingestion schema

Conventions follow the repo: every table has `tenant_id` and the `tenant_isolation` RLS policy, timestamps
are `timestamptz`, and every row keeps both the source clock and the arrival clock (G06). The bench is an
existing **equipment** row. The engine is a **unit under test**, not equipment.

```
equipment (bench) ──< test_cycle >── engine_unit
                         │
        ┌────────────┬───┴────────┬──────────────┐
  test_cycle_stage  waveform_capture  cycle_feature  cycle_verdict_confirmed
                         │
                   object storage (per-tenant prefix, D14)

equipment (bench) ──< bench_state_interval, bench_alarm      (UC-7)
telemetry_reading (existing) ← low-rate scalars: rig temps, motor current RMS, RPM  (UC-3, UC-6)
```

### 3.1 Cycle definition (versioned, immutable — D05)

```sql
CREATE TABLE test_cycle_definition_version (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  bench_equipment_id uuid NOT NULL,
  variant_code    text NOT NULL,            -- engine variant the script applies to
  version         int  NOT NULL,
  stages          jsonb NOT NULL,           -- [{stage_no, name, rpm_profile, duration_s, limits:{signal:{min,max,unit}}}]
  source_ref      text NOT NULL,            -- where the definition came from (PLC recipe / historian export)
  published_at    timestamptz NOT NULL,
  UNIQUE (tenant_id, bench_equipment_id, variant_code, version)
);
```

### 3.2 Engine and cycle (the anchor)

```sql
CREATE TABLE engine_unit (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  serial_no       text NOT NULL,
  variant_code    text NOT NULL,
  build_ref       text,                     -- MES build/order id, if TMCV exposes it
  UNIQUE (tenant_id, serial_no)
);

CREATE TABLE test_cycle (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL,
  bench_equipment_id  uuid NOT NULL,
  engine_unit_id      uuid NOT NULL REFERENCES engine_unit(id),
  definition_version_id uuid NOT NULL REFERENCES test_cycle_definition_version(id),
  attempt_no          int  NOT NULL DEFAULT 1,     -- retests of the same engine
  started_at          timestamptz NOT NULL,        -- source clock (PLC / NTP-synced edge)
  ended_at            timestamptz,
  received_at         timestamptz NOT NULL,        -- arrival clock
  status              text NOT NULL CHECK (status IN ('running','completed','aborted','invalid')),
  plc_result          text CHECK (plc_result IN ('pass','fail')),   -- what the bench decided
  plc_fail_codes      text[] NOT NULL DEFAULT '{}',
  invalid_reason      text,                        -- e.g. sensor self-test failed (UC-4)
  edge_device_id      text NOT NULL,
  source_cycle_ref    text NOT NULL,               -- PLC/historian id; idempotency key
  UNIQUE (tenant_id, bench_equipment_id, source_cycle_ref),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE test_cycle_stage (
  cycle_id        uuid NOT NULL REFERENCES test_cycle(id),
  tenant_id       text NOT NULL,
  stage_no        int  NOT NULL,
  stage_name      text NOT NULL,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  PRIMARY KEY (cycle_id, stage_no)
);
```

### 3.3 Sensor channels

This reuses the device catalogue. `sensor` is the definition, and the Q08S `sensor_instance` /
`signal_binding_version` work is where a physical channel is bound to a bench or engine position. The
channels the deck installs:

| Channel | Mount | Kind | Rate **[A]** |
|---|---|---|---|
| E1 accel X/Y/Z | engine block / head | waveform | 25.6 kHz |
| E2 microphone | stand-off | waveform | 48 kHz |
| E3 RTD | coolant / oil | scalar | 1 Hz |
| R1–R2 accel + RTD | spindle bearing housings | waveform + scalar | 25.6 kHz / 1 Hz |
| R3 CT ×3 | motor phases | waveform (+ RMS scalar) | 10 kHz / 1 Hz |
| R4 encoder | spindle | angle reference | per pulse |
| PLC | bench | torque (crank-angle), pressures, RPM, sequence, serial | per PLC scan / per degree |

Scalars at 1 Hz or slower go to the existing **`telemetry_reading`**, unchanged. Waveforms go to the next table.

### 3.4 Waveform captures (manifest in Postgres, samples in object storage)

```sql
CREATE TABLE waveform_capture (
  id                uuid PRIMARY KEY,
  tenant_id         text NOT NULL,
  cycle_id          uuid REFERENCES test_cycle(id),     -- null for rig captures outside a cycle (UC-3/6)
  bench_equipment_id uuid NOT NULL,
  stage_no          int,
  channel_key       text NOT NULL,          -- binding to sensor_instance (Q08S), e.g. 'E1.x'
  kind              text NOT NULL CHECK (kind IN
                      ('vibration','acoustic','motor_current','crank_angle_torque','pressure_decay','pressure')),
  domain            text NOT NULL CHECK (domain IN ('time','crank_angle')),
  sample_rate_hz    double precision,       -- domain = time
  angle_step_deg    double precision,       -- domain = crank_angle
  sample_count      bigint NOT NULL,
  unit              text NOT NULL,          -- canonical unit after calibration
  calibration_version_id uuid,
  started_at        timestamptz NOT NULL,   -- source clock of sample 0
  clock_offset_ms   double precision,       -- edge NTP offset at capture; rig↔engine alignment
  received_at       timestamptz NOT NULL,
  encoding          text NOT NULL,          -- e.g. 'parquet', 'float32le'
  storage_uri       text NOT NULL,          -- per-tenant prefix (D14 rule 3)
  byte_size         bigint NOT NULL,
  sha256            text NOT NULL,
  retention_class   text NOT NULL CHECK (retention_class IN ('sample','flagged','training','transient')),
  quality_flags     text[] NOT NULL DEFAULT '{}',   -- clipped, dropout, overrange, clock_unsynced
  UNIQUE (tenant_id, cycle_id, channel_key, stage_no, started_at)
);
```

### 3.5 Per-cycle features (computed at the edge or by a worker)

```sql
CREATE TABLE cycle_feature (
  cycle_id          uuid NOT NULL REFERENCES test_cycle(id),
  tenant_id         text NOT NULL,
  stage_no          int  NOT NULL DEFAULT 0,      -- 0 = whole cycle
  feature_key       text NOT NULL,                -- 'E1.rms_g', 'torque.peak_nm@bin_350_370', 'leak.decay_slope_kpa_s'
  value             double precision NOT NULL,
  unit              text NOT NULL,
  extractor_version text NOT NULL,                -- feature code version; immutable
  source_capture_id uuid REFERENCES waveform_capture(id),
  computed_at       timestamptz NOT NULL,
  PRIMARY KEY (cycle_id, stage_no, feature_key, extractor_version)
);
```

### 3.6 Confirmed outcome (the label)

```sql
CREATE TABLE cycle_verdict_confirmed (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  cycle_id        uuid NOT NULL REFERENCES test_cycle(id),
  final_result    text NOT NULL CHECK (final_result IN ('good','defect','rig_fault','sensor_fault','unknown')),
  root_cause_code text,                   -- TMCV's own code list (valve seating, ring leak, gasket, ...)
  source          text NOT NULL CHECK (source IN ('mes','qms','teardown','rework','warranty','operator')),
  confirmed_by    text,
  confirmed_at    timestamptz NOT NULL,
  supersedes_id   uuid REFERENCES cycle_verdict_confirmed(id)   -- a later teardown can revise
);
```

### 3.7 Bench state and alarms (UC-7)

```sql
CREATE TABLE bench_state_interval (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  bench_equipment_id uuid NOT NULL,
  state           text NOT NULL CHECK (state IN ('testing','idle','changeover','planned_stop','down')),
  reason_code     text,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  EXCLUDE USING gist (bench_equipment_id WITH =, tstzrange(started_at, ended_at) WITH &&)  -- no overlapping states, enforced by the DB
);

CREATE TABLE bench_alarm (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  bench_equipment_id uuid NOT NULL,
  alarm_code      text NOT NULL,
  severity        text NOT NULL,
  raised_at       timestamptz NOT NULL,
  cleared_at      timestamptz,
  source_alarm_ref text NOT NULL,
  UNIQUE (tenant_id, bench_equipment_id, source_alarm_ref)
);
```

---

## 4. Prediction outcome schema

The existing `prediction` table is **equipment × window × scenario** (`window_days`, `risk_score`). That
still suits UC-3 and UC-6 bench health on shift boundaries, so it's reused there. Cycle predictions
(UC-1, UC-2, UC-4, UC-5) are keyed by **cycle × use case × decision point** instead, so they get their own table.

```sql
CREATE TABLE cycle_prediction (
  id                uuid PRIMARY KEY,
  tenant_id         text NOT NULL,
  cycle_id          uuid NOT NULL REFERENCES test_cycle(id),
  use_case          text NOT NULL CHECK (use_case IN ('UC1_early_verdict','UC2_torque_signature',
                                                      'UC4_sensor_selftest','UC5_noise','UC5_leak')),
  model_ref         text NOT NULL,          -- 'uc1-gbm@3', 'selftest-rules@1'; immutable (G13)
  model_tier        int  NOT NULL,          -- 0/1 rules, higher only with approved evidence (G07)
  mode              text NOT NULL CHECK (mode IN ('shadow','advisory','in_loop')),
  run_namespace     text NOT NULL DEFAULT 'live' CHECK (run_namespace IN ('live','replay')),  -- G10
  decision_stage_no int,
  decision_offset_s double precision,       -- seconds into the cycle when the verdict was emitted
  predicted_label   text NOT NULL CHECK (predicted_label IN ('pass','fail','abstain','anomaly','normal',
                                                             'sensor_fault')),
  confidence        double precision CHECK (confidence BETWEEN 0 AND 1),  -- null for rules: no invented probabilities
  value             double precision,       -- e.g. predicted leak rate
  value_unit        text,
  value_interval    numrange,               -- uncertainty band where the model gives one
  suspected_source  text CHECK (suspected_source IN ('engine','rig','sensor')),   -- UC-2/3 separation
  suspected_class   text,                   -- valve_seating, ring_leakage, ... (TMCV code list)
  suspect_channel   text,                   -- UC-4 names the sensor
  recommended_action text CHECK (recommended_action IN ('release_early','continue','abort_and_diagnose',
                                                       'retest','check_sensor','none')),
  evidence          jsonb NOT NULL DEFAULT '[]',   -- [{feature_key, value, baseline, contribution}] / crank-angle ranges
  input_capture_ids uuid[] NOT NULL DEFAULT '{}',
  baseline_version_id uuid,                 -- per-variant baseline used (UC-2)
  computed_at       timestamptz NOT NULL,
  latency_ms        int,
  UNIQUE (tenant_id, cycle_id, use_case, model_ref, decision_stage_no, run_namespace),
  CHECK (mode <> 'in_loop' OR run_namespace = 'live')
);

CREATE TABLE cycle_prediction_action (     -- what actually happened; separate so the prediction stays immutable
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL,
  prediction_id   uuid NOT NULL REFERENCES cycle_prediction(id),
  action_taken    text NOT NULL,          -- released_early, aborted, ignored, work_order_raised
  actor           text NOT NULL,          -- user id or 'edge-auto'
  taken_at        timestamptz NOT NULL,
  work_order_id   uuid,
  UNIQUE (prediction_id, action_taken)
);
```

Bench health for UC-3 and UC-6 uses the existing `prediction` row per equipment/window. It needs two
additions in a **new** migration, never by editing one that's already committed:
`component_key` (spindle_bearing, drive_motor, coupling, fixture), and `rul_hours` + `rul_interval`,
both **nullable** and left null until a validated model exists.

**Evaluation** is a view, not a table: `cycle_prediction` ⋈ `cycle_verdict_confirmed` gives TP/FP/FN per
model and variant, early-PASS escapes (the metric that must stay at zero), and seconds saved
(`ended_at − started_at − decision_offset_s` for released cycles). This is the deck's slide-13 success metric.

---

## 5. Questions for TMCV (they block the schema)

1. Controller make/model, and the data path: an OPC-UA server or a historian export? At what rate is
   crank-angle torque available?
2. Typical cycle duration and number of stages per variant. How many engines per day per bench? (These
   size the volume estimate.)
3. How much historical data exists in the historian, with serial numbers? Months? How many failures per variant?
4. Does a confirmed root cause exist per failed engine (teardown/rework record in MES/QMS), and can we read it?
5. The fail-code list and root-cause code list. We use theirs, not ours.
6. Who signs off a cycle being shortened (UC-1 in-loop)? What false-pass rate is acceptable? (Expected answer: zero.)
7. Is MES "quality write-back" a requirement? It's an outbound integration with its own approval and idempotency (G09/G11).
