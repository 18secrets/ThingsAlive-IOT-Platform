# Platform 2.0 — AI layer decisions (D18–D39)

Continues `docs/ai/DECISIONS.md` in the repo (which ends at D17). Paste into that file from
the CLI when it next touches `docs/ai/`.

Standing constraints: everything hosted on Railway, no API calls, no token billing,
infrastructure under $50/month.

---

## D18 — Three layers, not one "AI"

1. **Deterministic** — physics, formulas, thresholds. No model. (QL1, QCE1/2.)
2. **Predictive** — time-series foundation models over live telemetry.
3. **Generative** — narration, selection and composition only. It never *performs*
   arithmetic; it may propose a formula that layer 1 computes and can refuse (D25).

Layers 1 and 2 are useful with layer 3 switched off. The dependency runs one way only:
layer 2 needs layer 1's signal bindings to have anything to forecast, and layer 3 needs
both to have anything to talk about. "Fails independently" means a failure never propagates
*upward*, not that the layers are unrelated.

## D19 — Model choices (all self-hosted, all CPU)

> **Superseded in part by D35 and D36. Do not read this decision alone.**
> D35: TTM runs as **PyTorch on CPU, not ONNX** — no ONNX export exists for that family.
> D36: the generative layer is **optional**, and the shift-boundary Qwen batch is behind a
> feature flag that is off by default. The table below is the original intent; D35 carries
> the measurements and D36 carries the current architecture.

| Role | Model | Where | Est. |
|---|---|---|---|
| Forecasting | Granite TinyTimeMixers (~1M params) via ONNX | inside the existing `scheduler` service, no new container | ~$4/mo |
| Embeddings | `bge-small-en-v1.5` via ONNX, in-process | api service | ~$2/mo |
| Framing / selection / composition | Qwen3-8B int4 (~5GB), loaded only for the shift-boundary batch | own service, ~15 min/day | ~$1–2/mo |

bge-small over BGE-M3: reindex cost scales with corpus size, and the corpus only grows.
Pin the choice in an `embedding_profile` row so a later change is a migration, not drift.

Batch-only Qwen: Railway bills observed usage per minute. An always-warm 5GB model is the
single largest avoidable cost in the stack.

Deferred: QLLM1 form-filler (Qwen3-1.7B, ~$11/mo). Not worth it yet.

## D20 — Anomaly detection is forecast residual

No separate anomaly model. TTM forecasts, actual arrives, residual beyond a learned band is
the anomaly. One model, one code path, and the explanation ("expected 62 °C, saw 81 °C")
falls out rather than having to be reconstructed.

**Two failure modes the band creates, both silent (added 2026-09-30).** Same defect class
as D28: the absence of a result reads as a clean result.

- **No band yet.** A newly commissioned machine has no residual history, so nothing ever
  exceeds the band and the machine reports no anomalies — indistinguishable on screen from
  a healthy machine. Anomaly detection therefore has three states, not two: `normal`,
  `anomalous`, and **`baseline_not_established`**. The third is shown as its own state and
  never as `normal`. Threshold: fewer than **14 days** of residuals for that signal.
- **A band learned during a fault.** If the machine was already degrading through the
  learning window, the fault is encoded as normal and never fires again. The band records
  the window it was learned from, and any period containing a raised alert or an open work
  order for that signal is excluded from it. A band that cannot find a clean window stays
  `baseline_not_established` rather than learning a dirty one.

## D21 — The recommendation engine is five-sixths deterministic

| Step | How |
|---|---|
| Detect | thresholds + TTM residual — no model |
| Attribute | library lookup `failure_mode → signals` — no model |
| Precedent | SQL over `alert_event`, `work_order`, service history — no model |
| Gap | set difference: what is occurring vs what is configured — no model |
| Cost | arithmetic over stored tenant parameters — no model |
| **Frame** | **the only model role**, split proposer → critic |

Proposer writes from one evidence bundle; critic strikes every claim the bundle does not
support. Two calls, same model, sequential. Maps onto the frozen contract: observations
carry `evidence_refs`, hypotheses carry `limitations`.

**Absence is not evidence (added 2026-09-30).** A new tenant has no alert history, no work
orders and no service records, so the Precedent step returns nothing. It must report
**"no history to search"** and not "no similar cases occurred" — the first is a statement
about the platform, the second is a claim about the machine, and only one of them is true.
Every deterministic step returns its coverage alongside its result: what it searched, over
what period, and how much it found.

## D22 — Recommendation content is library content

Recommendations are **authored by master admin per equipment class**, published, and
**copied into the tenant on grant** — the same template-and-copy mechanic as D04. They are
not generated per tenant.

- Two new platform-owned tables, versioned with the class:
  `equipment_class_failure_mode` and `equipment_class_recommendation`.
- The **Gap** step becomes a set difference against library rows rather than invention.
- The model's job shrinks from *authoring a procedure* to *picking the applicable library
  entry and attaching evidence* — closed-set selection, testable, and whose failure mode is
  a wrong pick from a valid list rather than an invented procedure.
- A client user sees populated, selectable recommendations the moment a class is granted,
  with zero telemetry history.
- When nothing in the library matches, the model drafts a **candidate library entry for
  master admin review**; it never surfaces unreviewed content to a tenant.

**The closed-set claim applies to one of two paths (corrected 2026-09-30).**

| Path | Risk | Controlled by |
|---|---|---|
| **Select** from published library content | worst case is a wrong pick from a valid list | construction — the set is closed |
| **Draft** a candidate entry when nothing matches | a plausible but wrong proposal reaching a reviewer | review, not construction |

The second is open-ended authoring, and it is the path most likely to be exercised early,
when the library is thin. Saying "the failure mode is a wrong pick from a valid list" was
true of the first path and not the second.

Three controls on the drafting path, because review alone is not enough at volume:

- a draft is **labelled unreviewed** and carries the evidence bundle that produced it; the
  reviewer sees the evidence, not just the prose
- a draft is produced only when the same unmatched pattern recurs — **three occurrences, or
  two machines** — so one anomalous machine cannot generate library noise
- drafts are **rate-limited per class per week**; a flood is a signal the library is wrong,
  not a reason to write fifty entries

Template goes to **v4**.

## D23 — No currency without tenant cost inputs

Costing needs cost-per-hour of unplanned downtime, labour rate, and parts cost per failure
mode. Until a tenant supplies them, consequences are expressed in **hours and events only**.
Superseded in mechanism by D31, which generalises this to all tenant parameters.

## D24 — Storage, not models, is what breaks the budget

Telemetry at current volume is ~450 GB/yr ≈ $67/mo on Railway volumes — larger than the
entire model stack. D14's 90-day retention plus Parquet archive is therefore a **budget
control**, not hygiene. QPART1 and QARCH1 are cost tasks and must not slip behind the model
work.

**This number is still an estimate (flagged 2026-09-30).** QSPIKE1 measured the model stack
and found two of my estimates wrong. Storage is now the **largest unmeasured number in the
budget** and the only one left. Measure it during QPART1: actual bytes per reading including
index overhead, actual rows per machine per day, and the real Railway volume price at that
size. An estimate that has survived because nobody checked it is exactly what QSPIKE1
existed to catch.

## D25 — Generation is typed emitters over a closed vocabulary, not a general agent

The recommendation engine decides *what is missing*. It does not write the artifact. A
**typed emitter** per artifact kind materialises it: one recommendation → one emitter
invocation → one draft artifact of a known type.

| Emitter | Emits | Closed vocabulary | What rejects it |
|---|---|---|---|
| **KPI / widget** | `equipment_class_formula` expression + presentation metadata | the class's declared signals, and the registered operator set | the QCE1 compiler |
| **Workflow** | a `WorkflowSpec` graph | registered node types, bound signals, published alert templates | the QWF1 compiler **plus historical replay** (D28) |

The FPGA rule is what makes this safe: operators and node types are TypeScript, a deploy.
The composition is a row.

**Stated precisely (corrected 2026-09-30).** "The model never emits code" was too loose —
the KPI emitter does write a formula expression, and an expression is a language. Three
statements, each exactly true:

- **Nothing the model writes is executed as written.** Every output passes through a
  compiler or a schema that can refuse it.
- **No expression ever enters the alert path.** Alert rules are stored parameters only
  (D34). The model may select and fill parameters; it may not write a condition.
- **A formula expression is permitted** and is compiled by QCE1 against a closed operator
  registry — a bounded vocabulary, not a general language. It does not compile, it does not
  publish.

So the worst possible output is a wrong arrangement of valid parts, never a new capability.

One substrate, several emitters — not several agents. An `artifact_proposal` table and a
propose → compile → gate → draft pipeline, with per-kind emitters plugged in.

The emitter is seeded by user selection in the UI (machine, failure mode, intent picked
from lists), never given an open request.

## D26 — Predicted values come from TTM only; the generative layer never emits telemetry

KPI and workflow are *composed*. Future signal values are *computed*. An LLM writing
"temperature will reach 81 °C on Thursday" is fabricated telemetry wearing the platform's
credibility, and on screen it is indistinguishable from the real thing.

- **The numbers** come from TTM (D19/D20). This is QML1; no emitter exists for prediction.
- **The generative layer's only role** in prediction is selecting which signal and horizon
  are worth forecasting, and naming the result.

Hard boundary, stated precisely: **no numeric value about the future may originate from a
language model.** A TTM forecast rendered into a sentence is fine and is the point — it
carries its provenance and its interval. A number the model produced itself is not, whether
it appears in prose, a chart or a recommendation.

The test is provenance, not format: every future-tense number on screen traces to a model
run with an id, a horizon and a confidence interval, or it does not appear.

## D27 — Generated artifacts are drafts, scope-routed, fully provenanced

| Scope | Meaning | Approver |
|---|---|---|
| **Tenant** | specific to this machine's configuration | tenant super admin |
| **Class** | applies to every machine of this type | **master admin**, as a candidate library entry |

Default is tenant draft. Promotion to library is always a human step, never inferred from
model confidence. Master-admin-initiated library authoring is class-scoped by construction,
so it routes correctly with no special case.

Provenance on every generated artifact, same pattern as import rows: `source='generated'`,
the recommendation id that spawned it, the evidence bundle id, the model id and version.

## D28 — Historical replay is the acceptance gate for anything that fires

Before a generated workflow or alert rule is shown to anyone, it is run against that
machine's last 90 days of telemetry and its fire count is reported with the draft.

A rule that reads beautifully and would have raised four thousand alerts is wrong, and no
amount of model critique catches that — arithmetic does. The refusal is structured, not a
warning the user can wave past.

**Corrected 2026-09-30 — the gate has three outcomes, not two.** A replay over a machine
with no history returns "0 fires", which reads as a clean pass and is the most dangerous
possible output. On a newly commissioned machine — exactly the day-one case D22 promises
value for — that is the *normal* state.

| Outcome | Meaning |
|---|---|
| `pass` | enough history, fire count within bounds |
| `refuse` | enough history, fire count outside bounds |
| `insufficient_history` | **not a pass.** Not enough readings to say anything |

`insufficient_history` when the bound signal has fewer than **14 days** of readings, or
fewer than 200 readings, whichever binds first. The draft is still offered — a library
recommendation is valuable on a machine with no history, which is the whole point of D22 —
but it is labelled as unvalidated, it states what history it had, and it cannot be
auto-enabled.

The same harness settles the parked dwell-time problem.

---

## D29 — The machine detail page is data, not code

A machine's detail page is a **composition of library-defined widgets bound to that
machine's signals**. Widget *types* are React components — a deploy. The *composition* is
library rows — data.

- One endpoint, `GET /api/equipment/:id/page`, returns layout, widget definitions,
  signal bindings, and **per-widget readiness**.
- The UI renders whatever comes back and hard-codes nothing per equipment class. A new
  class appears as a working page with **zero frontend work**.
- Same rule already in force for navigation (`GET /api/me/permissions`). Larger surface,
  identical reasoning: a UI that knows the class list is a UI that breaks on the second
  customer.

**Per-widget readiness is mandatory, in the four states.** A KPI whose sensor was never
fitted reports `unbound`; one whose sensor has gone quiet reports `stale`. A performance
ratio computed from a dead irradiance sensor, displayed as a confident 86.2%, is worse than
displaying nothing, because someone will act on it. This is why Q08S s3 (freshness) sits
**upstream** of the machine page, not after it.

## D30 — A KPI is a formula plus how it is read; sites are classes too

**Part 1 — KPI ≠ formula.** `equipment_class_formula` stores an expression. A KPI is that
expression plus display unit, display format, target value and direction, comparison basis,
aggregation window and chart type. Without the metadata the backend can compute `0.924` and
has no idea it is a percentage against a 90% target with a yesterday comparison. This
metadata is part of QCE1, not a later column sprawl.

**Part 2 — unit inference is compile-time.** Moved from QCE2 into QCE1: units are inferred
statically during compilation and a mismatch is a refusal to publish. QCE2 is runtime
execution only.

**Part 3 — a site is a class.** Plant-level KPIs (revenue today, CO₂ avoided, plant
availability, generation by block) are not equipment-class content. Introduce a **site
class** — solar plant, machine shop, cold chain — as library content in the same shape,
whose KPIs aggregate over member equipment. The alternative, letting each tenant author
their own plant page, means every customer rebuilds the same dashboard and the library
stops being a library.

## D31 — The library owns the formula; the tenant owns the parameters

A tariff of ₹0.80/kWh is not library content. Neither is a labour rate.

- A library KPI or recommendation **declares** the parameters it needs
  (`tariff_per_kwh`, `downtime_cost_per_hour`, `labour_rate`, `parts_cost`).
  For a **composed expression**, the compiler derives the declaration from `@name`
  references rather than trusting an author to list it. For a **backend-coded named formula**
  (D33), the registry entry declares its parameters in code, checked the same way. Both
  paths must populate `required_parameters`; a formula that declares none because nobody
  implemented its path is indistinguishable from one that needs none.
- A tenant **supplies values**, through a settings screen.
- A KPI whose parameters are unset renders `not_configured` with a route to that screen —
  **never zero, and never a placeholder number**.

This generalises D23: currency was only the first instance. Parameters are the mechanism.

## D32 — An unsupplied value is not a declaration

A DB default on a column that exists to be *checked against inference* turns "the author
said nothing" into "the author said scalar", and the check then refuses legitimate content.

- Columns checked against inference (`result_kind`, `display_unit`) are **nullable with no
  default**. NULL means infer, and the inferred value is persisted.
- An explicit value is checked, and a mismatch refuses the publish.
- Purely presentational columns (`display_format`, `aggregation_window`, `chart_type`) keep
  their defaults — nothing is checked against them.

Found by the CLI when reverting the template example broke two publish tests. The default
was the bug, not the inference.

## D33 — Physics lives in the backend; composition lives in the library

Two layers, not one.

**Named formulas — TypeScript, a deploy.** Performance ratio, specific fuel consumption,
volumetric efficiency, availability, OEE. Each declares its inputs **by role**, its unit and
its kind. An Excel author selects `performance_ratio` and maps roles to signals. Physics is
finite — on the order of fifty formulas across every machine class we will serve — so coding
them is bounded work, and it removes an entire class of authoring error.

**What it removes, precisely (corrected 2026-09-30).** The author cannot get the *units*
wrong — the registry declares them and the binding is checked. They can still bind the
*wrong signal*: mapping ambient temperature to a role expecting coolant temperature passes
every unit check and produces a confident wrong number. So each role declares what its input
must **measure**, not only its unit, and binding a signal whose measurement type does not
match the role is refused. Saying this guarantees correctness would be false.

**Derived expressions — library rows.** Arithmetic over named-formula outputs, signals,
literals and `@params`. "Revenue per operating hour" is not physics; it is a tenant's
arithmetic over a physics result. Requiring a deploy for that would make the library
unusable in practice.

The compiler from QCE1 serves both: its vocabulary gains `#named_formula` alongside signals
and parameters. Kind and unit for a named formula come from its backend declaration, not
from inference — so for the common path the ambiguity D32 addresses does not arise at all.

## D34 — Alert evaluation is explicit, never implied

"Set temp max to 105" is not a formula. It is a rule with an explicit reduction, and every
part of it is a stored parameter that a person can read back:

| Parameter | Default |
|---|---|
| `signal` | — |
| `bound` (`min` / `max`) and its value | — |
| `lookback_readings` (N) | **10** |
| `breaches_required` (M) | **6** |

**Corrected 2026-09-30.** The original rule — reduce the window with `max` for an upper
bound — was wrong, and wrong in the direction that matters. `max(last 10) > threshold`
fires when **any** of the ten breached, which is *more* sensitive than a single reading,
not less. It made the alert linger for ten readings after a spike without preventing the
spike from firing it. The stated purpose and the stated mechanism contradicted each other.

The reduction is **M of the last N readings breached**. Defaults N = 10, M = 6: a majority
of a five-to-ten-minute window at 30–60 s sampling. A single spike does not fire. A real
excursion fires within six readings.

M = N is available and means "sustained throughout the window" — the most conservative
setting. M = 1 reproduces the old single-reading behaviour and is allowed, but it is a
deliberate choice rather than the default. `M > N` is refused.

This renders plainly, which is the test of whether a rule parameterisation is right:
*"Fires when 6 of the last 10 readings of coolant temperature exceed 105 °C."*

**Alert rules are parameters, never free text.** A conversational request ("set temp max to
105 and alert me") compiles into a row, and the row renders back in plain English. The
generative layer never emits an expression into the alert path — consistent with D25, where
the model composes from a closed vocabulary and never writes code.

This also closes the parked dwell-time gap: `lookback_readings` is the dwell parameter the
engine never had.

## D35 — Measured (QSPIKE1), and two corrections to D19

Railway container as observed: **8 cgroup CPU cores, 8 GB memory**, consistent across two
deployments. Every number below is against that.

| Model | Runtime | Result |
|---|---|---|
| `bge-small-en-v1.5` | ONNX | **148 docs/sec**, 353 MB steady, 0.26 s cold load |
| `granite-timeseries-ttm-r2` | **PyTorch fp32 CPU** | **0.266 s for 1000 series**, 568 MB peak |
| Qwen3-8B Q4_K_M, and Qwen3-4B | llama-cpp-python prebuilt wheel | **No completed inference** after hours, twice |

**Correction 1 — TTM does not run as ONNX.** No ONNX export exists for that model family.
It runs as PyTorch on CPU. The numbers are excellent regardless, but the consequence is a
`torch` dependency in the `scheduler` image rather than a small ONNX runtime, which is a
build-size and cold-start cost that has not been measured yet. Measure it before QML1 ships.

**Correction 2 — the deterministic layers are not merely affordable, they are nearly
free.** TTM clears its threshold by roughly 2,250×. Forecasting is not a scarce resource
here: a larger fleet, a shorter interval or more signals per machine are all affordable,
and any future design should assume that rather than rationing forecasts.

**The Qwen result is not a verdict on Qwen.** The 4B fallback failed too, with 3 GB of
memory headroom spare, which rules out memory pressure and points at the runtime — a
generic prebuilt wheel most likely lacking AVX2/AVX512/FMA for this host. What was measured
is that *this build* does not work, not that the model cannot.

Total spend for the spike: **$1.18**.

## D36 — The generative layer is optional in phase 1; the renderer is deterministic

The spike changes the risk picture: the deterministic and predictive layers are cheap and
proven, and the generative layer is the only component that does not yet work. So the
architecture should not depend on it, and it does not have to.

D21 already reduced the model's job to framing one evidence bundle. D22 reduced it further,
to **selecting a published library recommendation** rather than authoring one. What is left
for a language model is phrasing — fluency, not capability.

Therefore:

- **QREC2 ships a deterministic renderer first**: sentence templates filled from the
  evidence bundle and the selected library recommendation. Zero cost, zero latency, and no
  possibility of an unsupported claim, because there is no generation step in which to
  invent one.
- **The model goes behind a feature flag**, off by default, taking the same input and
  producing the same contract. It buys better prose and nothing else.
- Phase 1 therefore ships whether or not a language model ever runs acceptably on Railway.

This is not a retreat. A recommendation assembled from library content and real evidence,
phrased by a template, is more trustworthy than the same content phrased by a model — and
the seam stays open for the day the runtime question is settled.

## D37 — The demo is the design target; its panels are the widget vocabulary

The `things-alive-demo` UI vision is adopted as the design target for the client console:
its screens, its vocabulary (Thing / Scenario / construction site), its provenance labels on
every number, its filters that survive navigation, its per-sensor ask-AI hooks.

It is **not** adopted as the architecture. It hand-wires one page for one fleet of
construction machines; D29 requires the same page to appear for any equipment class with no
frontend work.

The reconciliation makes the demo's work more valuable, not less: **each panel becomes a
widget type.** KPI tile, trend chart, sensor list, attention panel, cost block, twin — React
components, a deploy. The page composition becomes library rows — data.

Consequence for the UI team: the next task is not more screens, it is to **name the widget
types already present in the demo**, because that list is the closed vocabulary QREC0's page
layout composes from.

Two demo designs are adopted wholesale because they are better than what was specified here:
the **four-level effective-dated cost hierarchy** with per-field inheritance and source
attribution (into QPARAM1, replacing D31's sketch), and **alert suppression while a machine
is offline or its engine is off** (into QALERT1's follow-up).

Two demo assumptions cannot survive: the AI authoring **equipment** (machines are mirrored
read-only from the legacy backend — the model may propose a class-scoped library draft, never
a machine), and the **hosted OpenAI dependency** (demo-only; production is D19/D36).

## D38 — The twin is tiered, and readiness is the point

The twin's value is that a sensor marker is green, yellow or red **with a reason**. The
geometry is the least valuable part. A labelled schematic with 2-D hotspots delivers most of
the value at almost no content cost, and works for every class on day one.

| Tier | What | Content needed |
|---|---|---|
| **`list`** | readiness list per signal, no picture at all | **none** — works for every class on day one |
| **`schematic`** | image with 2-D hotspots | an image, and hotspots placed with the editor |
| **`model`** | GLB per class, shared by every tenant | a mesh, and 3-D anchors placed with the editor |
| **`variant`** | a specific make and model, customer or OEM supplied | its own mesh **and its own anchor set** |
| **site twin** | a site plan with machine pins | per customer; different content, different tool |

**Corrected 2026-09-30.** The original Tier 0 claimed to need "no anchor placement" while
storing a 2-D hotspot per signal — someone still had to place them, and the editor was not
due until Tier 1. Split in two: **`list`** genuinely needs nothing and is the universal
fallback; **`schematic`** needs placement and therefore ships **with the editor**, in its
simple click-on-an-image form. The 3-D editor extends that tool rather than replacing it.

**Anchors are keyed by asset, not by class.** A variant mesh has different geometry, so
class anchors would land in the wrong places on it. The model is
`visual_asset(id, class_slug, class_version, variant?, geometry_version, ref)` and
`visual_anchor(asset_id, signal, x, y, z?)`. A variant asset carries its own anchor set,
which is part of why it is priced as an exception.

Stored as class-versioned content (`equipment_class_visual` plus per-signal anchors, template
v4 sheet, assets in object storage rather than Postgres). Three rules: an anchor naming an
undeclared signal is **refused at publish**, never a silent fallback to another anchor;
markers render **per machine** from readiness, so a machine without that sensor fitted shows
no marker; and one model per class shared across tenants is what makes delivery cacheable.

**Sequencing:** Tier 0 ships inside QPAGE1; the schema lands in QREC0; the WebGL widget and
an anchor-placement editor come after QPAGE1; content authoring runs in parallel and is not
on the engineering critical path. Building it before QPAGE1 costs double, because it would
be hand-built as a bespoke page and then rebuilt as a widget.

The commercial question — class asset or customer asset — is answered by D39.

## D39 — The class is the product; the customer extends their copy

Every class in the library carries the full set: signals, formulas, KPIs, failure modes,
recommendations, and twin assets with a 3D view. On grant, the class becomes **the
customer's own copy** (D04). From that moment the copy is theirs, and it diverges in exactly
one way: **the customer adds signals**, because they fitted a sensor the class did not
anticipate. Everything downstream — readiness, thresholds, formulas, and the twin — reflects
that addition for that customer only.

The platform library is never modified by a customer. We author classes; they extend their
copies. That is what makes the content cost scale with machine *types* rather than machines.

### What makes it work: split the asset from the anchors

| | Ownership | Why |
|---|---|---|
| **The model asset** (GLB / schematic) | platform, immutable, class-versioned, shared by every tenant | one file per class serves everyone, so it caches and the bandwidth cost stays flat |
| **The anchor set** (signal → position) | copied on grant, then **tenant-owned** | this is the part that must diverge, and it is rows, not megabytes |

A customer never gets a new mesh. Their customisation is metadata. That single split is what
keeps Tier 1 economics intact while still letting every customer's twin be their own.

### A new signal goes to an unplaced tray, never onto a guess

When a customer adds a signal, its marker has no position on the model. It appears
immediately in an **unplaced list beside the twin**, labelled as not yet positioned, and can
be placed later with the anchor editor.

It is never auto-assigned to a nearby anchor. The demo's silent fallback —
`anchorParts[key] || anchorParts.engine_runtime` — puts a temperature reading on the fuel
tank and tells nobody, which is worse than showing no diagram.

### When the class publishes a new version

**Corrected 2026-09-30 — this covers every kind of class-derived content, not only anchors.**
A tenant copy carries signals, thresholds, formulas, KPIs, failure modes, recommendations,
page layout and anchors. All of them can diverge; all of them need the same rule.

Every row in a tenant copy carries an **origin**:

| Origin | On a new class version |
|---|---|
| `inherited` — came from the class, unmodified since grant | **updates** to the new version |
| `customised` — came from the class, the tenant changed it | **preserved**, flagged, the new class value offered as a suggestion |
| `tenant_added` — never came from the class | **preserved untouched** |

Two further rules:

- **A class version that removes something the tenant customised or built on does not
  delete it.** It is preserved and marked orphaned, with what it depended on named. Silent
  deletion of a threshold somebody tuned is the worst outcome available here.
- **Preserved is not the same as still valid.** If a new class version ships a different
  mesh, every tenant-placed 3-D anchor was positioned on the old geometry and may now float
  in the wrong place. The asset carries a `geometry_version`; when it changes, customised
  anchors are marked **`needs_recheck`** and shown in the unplaced tray rather than on the
  model until someone confirms them. "We did not move your marker" is not reassuring if the
  machine under it moved.
- **The upgrade is explicit, never automatic.** The tenant is offered the new version with a
  diff — what changes, what is preserved, what is orphaned — and accepts it. Auto-upgrading
  a published class under a running tenant changes their alert thresholds without their
  knowledge, which is not a feature.

The same three-way classification answers the anchor case as a special instance, and it is
what makes "the customer extends their copy" survive more than one class version.

### Two qualifications

**Publishing must not be gated on having a 3D model.** "Every class has twin assets" is the
goal, not the entry requirement. Tier 0 — schematic with 2-D hotspots — is a valid published
state, or library growth stalls behind 3D authoring and the library is the product.

**A tenant-added signal comes from the platform sensor catalog, not free text.** The catalog
already exists (`sensor_catalog`). Letting a customer invent a signal name and unit produces
unit drift that nothing downstream can reconcile — and unit mismatch silently unbinds rules.
They choose from the catalog; they do not author into it.

**Anchor validation is two checks, not one.** The publish-time refusal — an anchor naming a
signal the class does not declare — covers class content only. A tenant-added signal is not
in the class's declared list by definition, so the tenant side needs its own validator:
a tenant anchor must name a signal in **the tenant copy's** signal set, which is the class
signals plus what they added from the catalog. Same rule, different set, and without it the
tenant-side check was undefined.

**What this costs the roadmap — honestly.** Saying "nothing in the roadmap moves" was
optimism. D39 adds tenant-owned anchors, an origin classification on *every* content type,
an explicit upgrade flow with a diff, an unplaced tray, and a catalog picker for adding
signals. The origin column belongs in QREC0. The upgrade flow is **not currently anywhere**
and is a task of its own (QUPGRADE1). It is not large, but pretending it was free would have
meant discovering it during QREC0.

### The line between master admin and client super admin

A rule that will keep recurring, so state it once:

| | Master admin (Things Alive) | Client super admin |
|---|---|---|
| **Owns** | features, and the library for **every** client | everything specific to **their** operation |
| **Examples** | equipment classes, signals, formulas, KPIs, failure modes, recommendations, twin assets, publishing, tenant provisioning | cost rates and currency, which recommendations are enabled, tenant parameters, users and roles, site structure, signal extensions |

**Nothing client-specific is configured at platform level.** In particular, **costs and
currency are client configuration with no platform scope at all** — Things Alive does not
set, see or inherit a customer's rates.

That gives cost data a clean property: ordinary tenant isolation with no exception, and no
platform read path. A customer's fuel rate and downtime cost are commercially sensitive and
the platform has no reason to hold them.

### The loop this opens

When many customers add the same signal to the same class, that is evidence the library
should adopt it. Same mechanism as D22's candidate library entries: field evidence flows up,
master admin reviews, the class improves, every future customer benefits. The library gets
better with fleet size rather than each customer drifting further from it.

## D40 — Forecasting is cheap; the data around it is not

Measured (D35): TTM forecasts **1000 series in 0.266 s** in 568 MB. The question "will the
scheduler get heavy running ML every pass" has an arithmetic answer, and it is not the model.

### The numbers, at ten times today's fleet

| | Today (53 machines) | Design point (500 machines) |
|---|---|---|
| Series forecast | ~250 | ~2,500 |
| **Inference time per pass** | 0.07 s | **0.67 s** |
| **Input rows read** (512 points per series) | 128,000 | **1,280,000** |
| **Output rows if stored naively** (24 horizon steps × 24 passes/day) | 144,000/day | **1,440,000/day** |

Inference is a rounding error. Reading 1.28 M rows per pass, and writing more forecast rows
per day than telemetry rows, is not.

### Five decisions that follow

**1. A separate pass, never inside the shift runner.** Own schedule, own advisory lock, own
ledger. The shift runner's scoring must not wait on a forecast and must not fail because one
failed — the same rule the runner already applies to utilisation, device health and alerts.

**2. Same service, lazily loaded.** It stays in the existing `scheduler` container (no new
container, D19), but the model is loaded when the pass starts and released when it ends. The
cost of this choice is image size, not runtime — `torch` is a large dependency in a
container that also runs shift scoring. **Measure it before QML1 ships** (QML1-SIZE): image
size and cold-start time with and without torch.

**3. The library declares what is worth forecasting.** Not every signal, because it exists —
only signals a published KPI, recommendation trigger or explicit forecast declaration
consumes. This is the scaling lever: work is capped by content, not by fleet size × sensor
count. A class declaring five forecast signals costs half what one declaring ten costs, and
that is a decision an author makes visibly.

**4. Cadence is declared, and the default is four-hourly, not hourly.** TTM predicts 24
steps ahead; re-forecasting every hour re-predicts mostly the same future. Four-hourly cuts
read and write volume by 4× for almost no loss of freshness. An alert on a signal triggers
an **immediate re-forecast** for that machine, so the cases that matter are not waiting.

**5. Store the latest forecast, not every forecast.** One row per `(machine, signal)`
holding the current horizon, replaced each pass, plus the residual attached to each actual
reading as it arrives. A **daily sample** is retained for backtesting (QEVAL1). Storing every
horizon point of every pass would make forecast output exceed telemetry input — the model
would become the storage problem that D24 says storage already is.

### Two operational rules

- **Incremental.** Forecast only machines with new readings since their last pass. Skip
  offline and stale signals — a forecast from a dead sensor is a confident fiction.
- **Bounded, with a visible skip list.** Each pass has a time budget. When it cannot finish,
  it processes by priority — machines with active alerts or enabled recommendations first —
  and **records what it skipped**. A pass that silently covers 60% of the fleet is worse
  than one that covers 60% and says so.

## D41 — Prediction is a separate process from day one, a separate container on a trigger

The concern is right: as machines and history grow, forecasting inside the scheduler will
eventually hurt shift scoring. The answer is not to split now and pay for an idle container;
it is to **build it so the split is a config change**, and to say in advance what triggers it.

### The rule that makes the split cheap

The forecast pass is written as a **separate process with its own entry point** —
`dist/forecast-main.js`, its own advisory lock, its own ledger, no shared in-process state,
communicating with everything else only through the database. Today it is invoked inside the
`scheduler` container. Splitting it means adding a Railway service on the same repo with a
different start command and a `railway.forecast.json`. No code change.

If instead it were a method called inside the shift runner, sharing objects and caches, the
split would be a rewrite. That is the whole decision.

### Target topology

| Container | Holds |
|---|---|
| `api` | HTTP, Swagger, all request-scoped work |
| `scheduler` | shift runner and the other passes |
| `forecast` | TTM — **split on trigger, not yet** |
| `llm` | optional, off by default (D36) |
| `Postgres` | already its own service |

**One prediction service for all tenants, never one per tenant.** Inference is
tenant-agnostic compute; the model does not care whose readings it is given. Isolation lives
in the data layer — RLS, tenant-scoped queries — not in the container boundary. A container
per tenant multiplies idle cost by customer count and is the classic way a multi-tenant
platform stops being one.

### The triggers, decided now so the decision is not a judgement call later

Split `forecast` into its own service when **any** of these holds:

- forecast pass **p95 duration exceeds 25%** of its interval
- `scheduler` container memory **p95 above 70%** of its limit
- the skip list is **non-empty for three consecutive passes**
- adding `torch` pushes the image or deploy time to where the scheduler's release cadence
  suffers (measured by QML1-SIZE)

Each is observable without judgement, and each is a reason rather than a worry.

### What does not change

Everything in D40 still applies and applies harder after a split: the library decides which
signals are worth forecasting, cadence defaults to four-hourly, only the latest forecast is
stored, and a pass that runs out of budget records what it skipped. A separate container
makes the work survivable; it does not make it free.
