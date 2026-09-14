# DG and CNC class profiles — sourced draft for domain review

**Status: draft.** Everything in `src/database/seeds/catalog/` loads as `draft`, which
is invisible to tenants by construction. Nothing here can be activated until somebody
who has stood next to these machines has read it and published it. This document
exists so that review is a matter of checking numbers against experience rather than
reconstructing where each one came from.

This is task **P1-02** taken as far as desk research can take it. What it cannot
supply is the part that matters most: whether a failure mode is one your field
engineers recognise, and whether a threshold is one your customers' sets actually sit
near.

---

## 1. The finding that changes what is buildable

The DG profile is grounded in the signals your fleet already sends. The CNC profile is
not, and cannot be.

Your OBD-CAN decoder (`src/python-file/obd_can_data.py`, `OBDCanRecord`) emits exactly
these per frame, and the dataclass carries `genset_serial_number` — these loggers are
already on gensets:

| Wire field | Scaling in the decoder | Canonical name in 2.0 |
|---|---|---|
| `engine_rpm` | raw × 0.5 | `engine_rpm` |
| `engine_on_time` | u32 seconds, cumulative | `engine_on_time` |
| `coolant_temp_c` | (raw × 0.1) − 273.14 | `coolant_temp` |
| `oil_temp_c` | same deci-Kelvin | `oil_temp` |
| `fuel_temp_c` | same deci-Kelvin | `fuel_temp` |
| `oil_pressure_scaled` | raw ÷ 1000 | `oil_pressure` |
| `battery_voltage_v` | raw × 0.0625 | `battery_voltage` |

Plus `fuel_level_pct` from the fuel stream and `latitude`/`longitude`/`speed_kmph`
from GPS.

**Nine of the twelve DG scenarios run on that list today.** The three that do not are
blocked on signals the frame does not carry, and the recommendation engine says so by
name rather than hiding them.

**None of the CNC scenarios can run.** A machining centre needs spindle load, spindle
speed, vibration, following error, coolant chemistry — none of which any logger in the
current fleet produces, and most of which need a FANUC FOCAS or Siemens OPC UA
connection to the control rather than a sensor. The one exception is whole-machine
power draw, which a retrofit CT clamp gives you, and which is not much use without
`machine_state` to tell cutting from idling.

That is not a reason to leave the CNC class out. It is the clearest possible statement
of what a CNC engagement would require, and the catalog now produces it as a list of
named blockers rather than an empty screen.

---

## 2. Open questions, in the order they matter

### 2.1 What unit is `oil_pressure_scaled`? — blocks publishing

The decoder divides the raw 16-bit word by 1000 and declares no unit. The thresholds
drafted here (1.5 bar warning, 1.0 bar shutdown) are Kirloskar controller defaults in
**bar**.

If `raw / 1000` yields **MPa**, then a healthy set reads about 0.3–0.5 and the
scenario never fires — silently, forever, looking exactly like a fleet with no oil
pressure problems. If it yields **bar**, the numbers are right as drafted.

One reading from one healthy set at running speed settles it. Until then this is the
single most consequential unknown in the profile, because the failure mode is silence.

### 2.2 Are the deployed sets on 12 V or 24 V starting systems?

The KG934 factory defaults (10.0 V low warning, 13.1 V charge minimum, 18.0 V maximum)
describe a 12 V system. The draft carries a doubled 24 V set alongside them, marked as
unconfirmed. Most sets above about 62.5 kVA are 24 V, but that is a generalisation and
your fleet is the fact.

### 2.3 Is 250 hours the right service interval?

Used as the default for `dg-runtime-service-due`. It is common Indian practice for a
first oil change in the 50–125 kVA band, not a figure from any leaflet consulted here.
It almost certainly varies by engine model across a mixed KOEL / Cummins / Mahindra
fleet, and it is a per-asset field rather than a class constant.

### 2.4 Can the frame be extended to carry engine load?

Three scenarios want it. Wet stacking, in particular, is the one failure mode on this
list that is caused by how the customer runs the set rather than by anything wearing
out — which makes it the one most worth catching early, and the one you cannot catch
at all without a load figure. J1939 carries percent load at current speed; whether
your loggers can be asked for it is a question for whoever owns the firmware.

---

## 3. Where each threshold came from

### 3.1 Diesel generator

Kirloskar KG934V1 genset controller, factory defaults. These are the numbers the panel
in front of the machine already uses, which is why they were chosen over anything more
theoretical — an alert that disagrees with the panel is an alert the site ignores.

| Parameter | Default | Configurable range |
|---|---|---|
| Oil pressure warning | 1.5 bar | 0.2–3.1 bar |
| Oil pressure shutdown | 1.0 bar | 0.2–3.0 bar |
| Engine temperature warning | 95 °C | 70–200 °C |
| Engine temperature shutdown | 98 °C | 70–200 °C |
| Overspeed warning | 1600 rpm | 400–4000 rpm |
| Overspeed shutdown | 1650 rpm | 400–4000 rpm |
| Battery low warning (12 V) | 10.0 V | 9.5–24 V |
| Battery charge minimum | 13.1 V | 10–28 V |
| Generator voltage trip | 180 / 275 V | — |
| Generator frequency trip | 44 / 56 Hz | — |
| Crank time | 10 s | 1–30 s |
| Cool-down | 60 s | 0–3600 s |

Rated speed is 1500 rpm for a four-pole 50 Hz set, so the overspeed warning sits about
7% above rated.

**Load band and wet stacking** (Caterpillar, *The Impact of Generator Set
Underloading*): diesel sets are designed to run at 50–85% of nameplate; exhaust
slobber appears below **30% of rated output sustained**; the remedy is **30 minutes at
a minimum of 30% load for every four hours** of light-load running. Those four numbers
are the entire `dg-wet-stacking` scenario.

**Fuel consumption** (Kirloskar Electric Bliss 50–125 kVA leaflet, at rated load):
12.4 L/h at 50 kVA, 15.3 at 63–75, 20.0 at 82.5, 23.9 at 100, 29.0 at 125. Oil sump
9 L (50–63 kVA) or 14 L (75–125 kVA); coolant 3 L or 26 L across the same split.
The 29 L/h figure is used as the physical burn ceiling in the pilferage scenario — a
tank falling faster than the largest set in the band can burn is not combustion.

**Pilferage**: calibrated specific fuel consumption runs **0.23–0.28 L/kWh**, and a
**±5%** deviation from expected burn is the common trigger for investigation.
Published estimates put DG fuel theft and inefficiency at **8–15% of backup power
cost**, with monitoring typically recovering 6–12%. Those numbers are the commercial
case for the scenario, not thresholds — treat them as such.

**CPCB IV+** came into force for gensets in India from July 2023. Sets sold since carry
aftertreatment the older fleet does not, which changes the low-load story materially
(a DPF-equipped set has a regeneration cycle to reason about). This draft does not
model that. If the fleet includes post-2023 sets, that is a second version of the
class rather than a parameter on this one.

### 3.2 CNC machining centre

**Vibration** — ISO 10816-3, Group 2 (15–300 kW), RMS velocity in mm/s:

| Zone boundary | Rigid foundation | Flexible foundation |
|---|---|---|
| A/B (good → satisfactory) | 1.4 | 2.3 |
| B/C (satisfactory → unsatisfactory) | 2.8 | 4.5 |
| C/D (unsatisfactory → unacceptable) | 4.5 | 7.1 |

Foundation type is a scenario parameter rather than an assumption, because the same
machine bolted differently has different limits and getting it wrong is a factor of
1.6 in either direction.

**Spindle temperature**: warning 48.9 °C, critical 60 °C (converted from the 120 °F /
140 °F figures in condition-monitoring practice). Bearings reach about 45 °C in normal
service, so the warning point deliberately sits just above routine running.

**Load**: 15% above established baseline for warning, 25% for critical. Against a
baseline rather than an absolute — the same machine cutting aluminium and cutting EN8
has two different normals.

**Cutting fluid** (Castrol metalworking fluids troubleshooting paper): concentration
5–10%, below 4% is insufficient protection, above 10% foams and above 15% smells;
pH 8.0–9.5 by design; chlorides above 300 ppm and water hardness above 25 grains per
gallon both raise corrosion risk.

**Lead times**: vibration analysis gives 4–8 weeks of warning, temperature monitoring
2–4 weeks. That is why `cnc-spindle-bearing-wear` asks for 60 days of history — the
warning only exists relative to a baseline.

Indian OEMs whose machines this class is meant to cover: Jyoti CNC Automation, Ace
Micromatic / Ace Designers, Bharat Fritz Werner, Lakshmi Machine Works, Macpower CNC,
Lokesh Machines, HMT Machine Tools. Controls are predominantly FANUC and Siemens,
which is what makes a control interface the realistic data path rather than sensors.

---

## 4. Two things worth fixing in the existing platform

Neither blocks 2.0. Both were found while establishing the signal vocabulary.

**The name normaliser strips real characters.** `normalizeMeasurementName` in
`src/workflows/services/sensor-name.ts` ends with
`.replace(/(?:degrees?)?(?:celsius|fahrenheit|kelvin|degc|degf|c|f|k)$/, '')`. The
alternation includes bare `c`, `f` and `k`, so any measurement name ending in one of
those letters loses it. It does the intended job on `engine_oil_temp_degC`, and it
also turns `pf` into `p`. 2.0 uses an alias table instead: a row per spelling, which
is longer to maintain and cannot surprise anyone.

**A generic temperature condition matches every temperature.** `measurementNameMatches`
returns true when the expected name is `temp` and the actual ends in `temp`. An alert
authored against "temperature" therefore fires on coolant, oil **and** fuel
temperature. That may be deliberate; if it is, it is worth saying so on the authoring
screen, because the three have different thresholds and only one of them is 95 °C.

---

## 5. What is in the repository

```
src/database/seeds/catalog/
  equipment-classes.json    2 classes, 23 declared signals, 18 failure modes
  scenarios.json            20 scenarios — 12 DG, 8 CNC
  signal-aliases.json       62 aliases → 23 canonical signals

src/database/seeds/seed-catalog.ts      loads the above; --publish for test databases
src/database/seeds/seed-demo-fleet.ts   9 assets spanning every possible answer
test/seed-catalog.spec.ts               runs the real content through the engine
```

The seeder refuses to load a scenario that requires a signal its class does not
declare. Without that check, a typo produces a scenario permanently blocked with
`missing-signals: ['coolent_temp']`, telling a customer to fit a sensor that is
already fitted — and the engine cannot tell a misspelling from an absent sensor.

The demo fleet is not a realistic customer. It is one asset per interesting state, so
that every bucket and every blocker code appears in a single pass:

| Asset | What it demonstrates |
|---|---|
| `DG-KOEL-125-001` | Healthy: full frame, 13 months of history, advanced tier — 9 of 12 available now |
| `DG-KOEL-125-002` | Same hardware, basic tier — the commercial blocker, not an engineering one |
| `DG-CUMMINS-62-003` | Commissioned 9 days ago — insufficient history, with a date |
| `DG-MAHINDRA-40-004` | Old logger, fuel and speed only — missing signals named individually |
| `DG-KOEL-30-005` | Mapped, never reported — blocked, and deliberately no date |
| `DG-UNKNOWN-006` | Unclassified — one fixable thing, not an empty screen |
| `DG-NODEVICE-007` | No logger — says so, without reciting eight sensors |
| `DG-RETIRED-CLASS-009` | Class not in the catalog — `notApplicable`, not "wait" |
| `CNC-JYOTI-VMC-008` | The honest CNC case: everything blocked, each naming what it needs |

---

## 6. What review needs to decide

1. **Oil pressure units.** One reading from a healthy set. Blocks publishing.
2. **Which failure modes are real.** Ten drafted for DG, eight for CNC. A mode your
   engineers do not recognise produces alerts nobody acts on, and the fastest way to
   lose a customer's attention is a channel they learn to mute.
3. **Whether the thresholds match your fleet.** OEM defaults are a starting point;
   a set that runs at 92 °C every afternoon in Chennai needs a different warning point
   from one in an air-conditioned plant room.
4. **Severities.** Drafted from consequence, not from how your support rota is
   structured. `dg-coolant-overheat` and `dg-lube-oil-pressure-loss` are marked
   critical; everything else is lower.
5. **Whether the CNC class ships at all in phase one.** It is honest and complete and
   runs nothing. It may be better as a sales artefact than as a catalog entry.

Once 1–4 are settled, publishing is one seeder run with `--publish`, and P1-03 is done.
