# QCE1 — the formula compiler

Paste this whole file into Claude Code CLI in `C:\dev\things-alive-iot-platform-2.0`.
Read `CLAUDE.md` first; every rule in it applies here.

Save a copy at `docs/ai/tasks/calc-engine-prompts.md` as part of this task.

**Branch:** `git checkout main && git pull && git checkout -b feature/calc-engine`

---

## What already exists

- `equipment_class_formula` (migration `1757970000000-LibraryStructure`) stores a formula
  expression as text and has **never evaluated it**. It carries reserved, still-unused
  columns: `compiled_plan`, `compiled_at`, `compiler_version`.
- `equipment_class_profile (slug, version)` holds `expected_signals` — the declared signal
  vocabulary of a class. A formula may reference nothing outside it.
- `catalog-import-validator.service.ts` already resolves formula inputs at import time and
  rejects a formula referencing an undeclared signal. That check stays; this task makes it
  call the real compiler instead of its own lighter check.
- `catalog.publish` is the capability guarding publication. Publication is the enforcement
  point for everything below.

## What this task builds

A compiler that turns a formula expression into a `compiled_plan`, and **refuses** anything
it cannot prove safe. Plus the presentation metadata that turns a formula into a KPI.

It does **not** execute anything. Runtime evaluation is QCE2.

---

## 1. The expression language

Deliberately small. A hand-written recursive-descent parser, roughly 200 lines. **Do not
add an expression-parsing dependency** — formulas arrive from uploaded spreadsheets, which
is an untrusted input path, and a third-party parser is supply-chain surface plus loss of
control over refusal messages.

```
expression := term (('+' | '-') term)*
term       := factor (('*' | '/') factor)*
factor     := '-' factor | primary
primary    := number | call | signal | param | '(' expression ')'
call       := identifier '(' [ expression (',' expression)* ] ')'
signal     := identifier
param      := '@' identifier
number     := digits [ '.' digits ]
```

An identifier followed by `(` is a call; otherwise it is a signal reference and must
resolve against the class's `expected_signals`.

**Absolutely no `eval`, no `new Function`, no `vm`, no template-string execution.** The
parser produces a tree; the tree is data. If a reviewer can find a path from a spreadsheet
cell to executed JavaScript, this task has failed.

## 2. The operator registry

A single TypeScript table — the closed vocabulary. Adding an operator is a deploy; that is
the point (FPGA principle: operators are code, compositions are rows).

| Function | Args | Result | Unit of result |
|---|---|---|---|
| `avg`, `min`, `max`, `first`, `last` | (series) | scalar | unchanged |
| `sum` | (series) | scalar | unchanged |
| `count` | (series) | scalar | dimensionless |
| `delta` | (series) | scalar | unchanged |
| `integrate` | (series) | scalar | unit × hour |
| `rate` | (series) | scalar | unit ÷ hour |
| `fraction_within` | (series, scalar, scalar) | scalar | dimensionless |

`integrate(active_power)` in MW yields MWh — that is how generation is derived from power,
and it is the reason a unit system is needed at all. `fraction_within(x, lo, hi)` is how
availability and in-band time are expressed; its bounds must carry the same unit as the
series.

Each registry entry declares: name, arity, argument kinds, result kind, unit rule. The
parser and the compiler both read this table. Neither hard-codes a function name.

## 3. Types and units

**Two kinds.** A signal reference is a `series`. Everything else reduces to `scalar`.
Arithmetic on a series and a scalar yields a series; on two series, a series.

`equipment_class_formula` declares `result_kind`. A KPI tile is `scalar`; a chart line is
`series`. A formula whose inferred kind differs from its declared kind is refused — this
single rule kills a whole family of nonsense, such as a KPI tile bound to an un-aggregated
signal.

**Units.** Represent a unit as base units in numerator and denominator plus a time
exponent — enough for the operator table above, and far short of a general units library.
Do not pull one in.

- `+` and `-` require identical units.
- `*` combines, `/` divides.
- A numeric literal is dimensionless.
- The inferred result unit is compared against the declared `display_unit`, after
  normalisation. A mismatch is a refusal.

Signal units come from the sensor library's canonical unit for that signal. A signal whose
unit is unresolved is a refusal, not a guess.

## 4. The compiled plan

A JSON tree stored in `compiled_plan`. Node kinds: `const`, `signal`, `param`, `unary`,
`binary`, `call`. Every node carries its inferred `kind` and `unit`.

Alongside it, record on the row:

- `compiler_version` — bumped whenever the emitted shape or the registry changes, so a plan
  compiled by an older compiler is detectable rather than silently trusted.
- `result_unit` — the inferred unit.
- `required_signals` — derived, not author-supplied.
- `required_parameters` — derived from `@name` references. This is what QPARAM1 will read;
  it is derived here so no author can forget to declare one.

**Compilation must be deterministic.** The same expression compiles to byte-identical JSON
every time: canonical key order, stable number formatting. The catalog import's
identical-content comparison depends on it — we have already been bitten once by `'[]'`
not equalling `[]`, and a non-deterministic plan would mint a new class version on every
re-upload.

## 5. Where compilation happens

- **At publish.** `catalog.publish` compiles every formula in the version. A formula that
  does not compile blocks the publish and names the formula and the reason. Draft content
  may be broken; published content may not.
- **At import dry-run.** The validator calls the compiler in dry-run mode so a bad formula
  appears in the diff the author reads, not hours later at publish. Same compiler, same
  refusals, nothing written.

## 6. Migration — KPI presentation metadata

Add to `equipment_class_formula`. Published versions are immutable, so this is additive
only; give every column a default that leaves existing rows valid.

| Column | Notes |
|---|---|
| `result_kind` | `'scalar'` \| `'series'` |
| `display_unit` | the unit the author intends; compared against the inferred unit |
| `display_format` | e.g. `number:1`, `percent:1`, `currency` |
| `target_value`, `target_min`, `target_max` | nullable |
| `target_direction` | `'higher_better'` \| `'lower_better'` \| `'band'` \| `'none'` |
| `comparison_basis` | `'none'` \| `'previous_period'` \| `'target'` |
| `aggregation_window` | `'shift'` \| `'today'` \| `'24h'` \| `'7d'` \| `'30d'` \| `'mtd'` \| `'ytd'` |
| `chart_type` | `'none'` \| `'line'` \| `'bar'` \| `'area'` \| `'gauge'` |
| `result_unit`, `required_signals`, `required_parameters` | derived at compile; never author-supplied |

A CHECK that `target_direction = 'band'` requires both `target_min` and `target_max`, and
that `'higher_better'`/`'lower_better'` require `target_value`.

Do **not** add layout, slot or ordering columns. Page composition is QREC0/QPAGE1.

## 7. Refusals — the test list

Follow QL1's pattern: **every refusal gets a test that attempts it.** A refusal with no
test asserting it does not exist.

1. Unknown function name
2. Wrong arity for a known function
3. Signal not present in the class's `expected_signals`
4. Signal whose canonical unit cannot be resolved
5. Unbalanced parentheses, and a trailing operator — error names the character position
6. Division by a literal zero
7. `+` or `-` across two different units
8. Inferred result unit ≠ declared `display_unit`
9. Inferred `result_kind` ≠ declared `result_kind`
10. An aggregation nested inside an aggregation — `avg(avg(x))`
11. An aggregation function given a scalar argument
12. `fraction_within` whose bounds do not carry the series' unit
13. Expression exceeding **200 nodes** or **depth 20** — a guard on an untrusted input path
14. Publishing a version containing any formula that fails to compile — the publish is
    refused and the message names the formula

Plus three that assert correct behaviour rather than refusal:

15. `integrate` over a power signal in MW yields a unit of MWh
16. The same expression compiled twice produces byte-identical `compiled_plan`
17. **Every formula in the shipped seed catalog compiles.** This is the test that stops the
    seed drifting into content that cannot be published — the same failure we already had
    once, when the template's own example failed the template's own validator.

## 8. Out of scope

- Runtime evaluation, time-window resolution, gap and null handling — QCE2.
- Tenant parameter values — QPARAM1. This task only derives which parameters are needed.
- Page layout, widget slots, site-level aggregation — QREC0 / QPAGE1.
- Any change under `frontend/`. None. Not one file.

## 9. Done when

- `npm run build` clean, `npm test` green, and the new tests **actually run** — check the
  reported test count went up, do not trust a passing summary.
- Full migration chain runs from an empty database, and the down path of the new migration
  reverses cleanly. Name the migration explicitly in the down-path test
  (`undoMigrationNamed`) — do not use `undoLastMigration`.
- A publish attempt on a version containing a broken formula is refused with a message that
  names the formula and the reason.
- Report back: the commit SHA, the test count before and after, and any refusal in the list
  above you could not implement, with the reason.

---

# QCE1.1 — literal units, and formula composition restored

Branch: feature/calc-engine, after QCE1 (6608698).
Append this task to docs/ai/tasks/calc-engine-prompts.md.
Read CLAUDE.md first; every rule in it applies.

Two corrections to QCE1. Both are errors in the QCE1 task spec, not in your
implementation of it.

---

## Correction 1 — a numeric literal has no unit claim

The QCE1 rule "a numeric literal is dimensionless" is correct for * and / and
wrong for + and -.

`105 - coolant_temp_c` is a legitimate KPI (headroom to limit) and refusing it
produced a weaker shipped template example. `fraction_within(signal, 80, 100)`
is the primary intended use of that operator and is currently impossible to
express at all.

New rule:

- In + and -, a numeric literal is unit-polymorphic: it adopts the unit of the
  other operand, and the result carries that unit.
- In * and /, a numeric literal remains dimensionless, exactly as now.
- fraction_within(series, lo, hi) accepts bounds that are either literals
  (which adopt the series' unit) or expressions carrying the series' unit. An
  expression carrying a different unit is still refused.
- Two literals added together are dimensionless, as now.

The refusal that must survive: + or - between two NAMED quantities with
incompatible units, e.g. avg(power_mw) + avg(coolant_temp_c). A bare number
never was one of those.

Tests to change:

- Refusal test 7 (+/- across different units): confirm it uses two signals, not
  a signal and a literal. If it uses a literal, rewrite it to use two signals
  with different units. The refusal must still fire.
- Refusal test 12 (fraction_within bounds): rewrite so the mismatch comes from
  a signal-bearing expression of the wrong unit. Literal bounds must now pass.
- Add: `105 - coolant_temp_c` compiles, inferred unit degC.
- Add: `fraction_within(x, 80, 100)` compiles with literal bounds.
- Add: `avg(power_mw) + avg(coolant_temp_c)` is still refused.

Restore the shipped template example in template-schema.ts to
`105 - coolant_temp_c`. Test 17 then covers it permanently.

---

## Correction 2 — formula composition, restored explicitly

QCE1's grammar removed a working feature: a formula referencing another
formula's output within the same class. That was an omission in the task spec.
It comes back, with its own syntax rather than the old overloaded bare
identifier.

Syntax: #formula_key — distinct from a signal (bare identifier) and a parameter
(@name). Unambiguous, greppable, and the dependency is visible in the
expression text.

    primary     := number | call | signal | param | formula_ref | '(' expression ')'
    formula_ref := '#' identifier

Semantics:

- A #ref resolves to another equipment_class_formula row in the SAME class and
  version. Nothing cross-class, nothing cross-version.
- Its kind and unit are the referenced formula's inferred kind and unit, which
  the compiler already computes. Nothing new is inferred, it is reused.
- Plan node kind is `formula_ref`, carrying the referenced formula_key. QCE2
  decides at runtime whether to inline or memoise; this task does not.
- required_signals is the TRANSITIVE closure — a composed formula requires
  everything its references require. Per-widget readiness depends on this being
  transitive, so it is not optional.
- Record required_formulas alongside it, derived.

Compilation order: build the dependency graph for the class's formulas and
compile in topological order, so a referenced formula's unit and kind are known
before a referencing one is compiled.

New refusals, each with a test that attempts it:

18. #ref to a formula key that does not exist in the class version.
19. A dependency cycle — direct (a -> a) and indirect (a -> b -> a). The error
    names the cycle.
20. #ref whose referenced formula itself failed to compile — the error names
    both.
21. Composition depth beyond 5 levels; and the 200-node / depth-20 caps applied
    to the EXPANDED expression, not just the written one. An untrusted
    spreadsheet must not be able to build a 200-node bomb out of five 40-node
    formulas.

Restore the original test in test/catalog-import-validate.spec.ts that
exercised formula-to-formula reference, rewritten to the #key syntax. Do not
leave the substituted scenario in place as if nothing was lost.

---

## Not in this task

- Template columns for result_kind / display_unit — these go into template v4
  with Q08S s3 and QREC0. Refusals 8 and 9 remain publish-time only until then;
  that is correct and deliberate.
- Runtime evaluation of formula_ref nodes — QCE2.
- Any change under frontend/.

## Done when

- npm run build clean; npm test green; report test count before and after,
  measured the same way you measured QCE1 (stash back and run, not the summary
  line).
- Full migration chain from an empty database still clean. No new migration is
  expected — if you find you need one, say why before adding it.
- compiler_version bumped, since the emitted plan gains a node kind and the
  unit rules changed. A plan compiled by the previous version must be
  detectable.
- Report back: commit SHA, test counts, and anything you could not implement
  with the reason.

---

# QCE3 — the named formula catalogue

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/named-formulas`

Migration timestamp above everything on `main` **and** above `1758060000000` from the
sensor-review branch. Check both.

---

## 0. Before anything else — commit the architecture record

Four documents are being handed to you alongside this prompt. Commit them under `docs/ai/`
in the first commit on this branch, unmodified:

```
docs/ai/decisions/ai-layer-decisions.md
docs/ai/analysis/itdc-coverage-analysis.md
docs/ai/analysis/itdc-telemetry-usecases.md
docs/ai/task-register.md
```

They are the reason you could not find "ITDC". From now on every task can be checked against
them without asking.

---

## 1. The problem

The formula registry is keyed `(classSlug, formulaKey, classVersion)`. A formula belongs to
one class version and is invisible to every other class.

`fuel_consumption / engine_runtime` is the same physics on an excavator, a crane and a
generator. Today it is authored separately on each, by hand, in an expression column. Forty
classes means forty transcriptions and no way to correct a mistake everywhere at once.

**The split:** the *formula* is platform knowledge — physics, authored once, published,
immutable. The *binding* of that formula to a class's actual signals is class content.
Same principle as operators versus compositions: the physics is fixed vocabulary, the wiring
is data.

## 2. `named_formula` — platform-owned, versioned, immutable when published

New table. No tenant column. Lifecycle `draft` → `published` exactly like
`equipment_class_profile`, and published rows are never edited.

```
named_formula (
  id, slug, version,
  name, description, category,
  expression            text   -- written against ROLE names, not signals
  inputs                jsonb  -- see below
  result_dimension      text
  result_kind           text   -- 'scalar' | 'series'
  status, published_at, created_by, updated_at,
  UNIQUE (slug, version)
)
```

`inputs` is an ordered array:

```json
[ { "role": "fuel_rate",    "dimension": "volume/time", "description": "..." },
  { "role": "power_output", "dimension": "power",
    "expected_parameters": ["engine_power", "shaft_power"] } ]
```

- `expression` is written against **roles**: `fuel_rate / power_output`. It is parsed and
  type-checked by the existing QCE1 compiler at **publish** time, with each role treated as
  a signal of its declared dimension. A formula that does not compile cannot be published.
- `result_dimension` is **verified against** what the compiler infers, not trusted. A
  mismatch refuses the publish and names both.
- `expected_parameters` is **optional** and is a warning, not a constraint — see §4.

`#formula_key` composition from QCE1.1 stays exactly as it is. That composes formulas within
one class. This is across classes. Do not merge the two mechanisms.

## 3. Binding — the Excel `formula` sheet gains a second mode

Two modes, mutually exclusive, per row:

| mode | columns filled |
|---|---|
| **expression** (today, unchanged) | `expression` |
| **bind** (new) | `named_formula`, `named_formula_version`, `bindings` |

`bindings` is `role=signal` pairs, semicolon-separated:
`fuel_rate=fuel_consumption; power_output=engine_power`

Refuse, with a distinct code each:

- both `expression` and `named_formula` filled → `formula_mode_conflict`
- neither filled → `formula_mode_missing`
- a role in `bindings` that the named formula does not declare → `unknown_role`
- a declared role absent from `bindings` → `unbound_role`, naming it
- `named_formula` slug or version not found, or not `published` → `named_formula_not_found`

The column is **optional** — existing workbooks keep working. **Do not bump the template
version**; QREC0 owns the v4 bump.

## 4. Unit checking at bind time, and the limit of it

For each binding, the bound signal's unit must be dimensionally compatible with the role's
declared `dimension`. Incompatible → **refuse at publish**, naming the role, the signal, the
expected dimension and the actual unit.

**And state the limit plainly, in the code comment and in the refusal message vocabulary.**
Dimensional checking cannot catch a wrong signal of the right dimension. Coolant temperature
and oil temperature are both `degC`; binding one where the other belongs passes every check
and produces a plausible wrong number. This was recorded as a correction to D33 and it is
the single most important thing to be honest about in this feature.

Hence `expected_parameters`: when the role declares it and the bound signal's
`parameter_key` is not in the list, emit **`suspicious_binding`** — a warning carrying the
role, the bound signal and the expected list. Publish is refused unless the author passes
`acknowledgeWarnings: true`, the same deliberate, audited override QIMP4 established. Not a
refusal: the list cannot be exhaustive and a legitimate unusual binding must remain
possible.

## 5. Compilation and what gets stored

At class publish, a bound formula compiles to the **same `compiled_plan` shape** an
expression-mode formula produces — roles substituted for bound signals before compilation.
Downstream, nothing knows the difference.

Store the provenance on the class formula row: `named_formula_slug`,
`named_formula_version`, `bindings`. So a published class records which physics it used and
at which version, forever.

**The reference is not live.** Publishing `v2` of a named formula changes nothing already
published. Existing classes keep their compiled plan and their recorded `v1`. Moving a class
to `v2` is a new class version, authored deliberately.

**Tenant copies carry the compiled plan, not the reference.** Copy-on-grant (D04) already
copies class content into the tenant; it copies the plan and the provenance fields as data.
A tenant must never resolve a platform catalogue row at runtime.

## 6. Endpoints

```
GET    /api/v1/platform/catalog/named-formulas            list, filter by status and category
GET    /api/v1/platform/catalog/named-formulas/:slug      all versions
POST   /api/v1/platform/catalog/named-formulas            create draft      catalog.write
PATCH  /api/v1/platform/catalog/named-formulas/:slug/:v   edit draft only   catalog.write
POST   /api/v1/platform/catalog/named-formulas/:slug/:v/publish              catalog.publish
```

The list endpoint is what the console's picker reads. Return `inputs` with it — the UI needs
the roles to render the binding form.

**Same validator, both paths.** A named formula created through the API goes through exactly
the checks §2 describes. QIMP4 established this; do not open a second door.

## 7. Seed content

Seven published named formulas, in the migration, as real platform content — not fixtures:

| slug | expression | result |
|---|---|---|
| `specific_fuel_consumption` | `fuel_rate / power_output` | volume/energy |
| `fuel_per_hour` | `fuel_rate` aggregated | volume/time |
| `load_factor` | `actual_power / rated_power` | ratio |
| `temperature_rise` | `outlet_temp - inlet_temp` | temperature |
| `pressure_differential` | `upstream_pressure - downstream_pressure` | pressure |
| `duty_cycle` | `running_time / total_time` | ratio |
| `co2_from_fuel` | `fuel_volume * emission_factor` | mass |

These come straight from the ITDC coverage analysis you will have committed in §0 — read
§2 of it before writing them. If any does not compile against the current operator
vocabulary, **report it rather than inventing an operator**. QCE4 adds operators; this task
does not.

## 8. Tests

1. A named formula whose expression does not compile cannot be published.
2. `result_dimension` disagreeing with the inferred dimension refuses the publish, naming both.
3. A published named formula cannot be edited; a draft can.
4. Each of the five binding refusal codes in §3 fires on its own condition.
5. A binding whose unit is dimensionally incompatible refuses the class publish.
6. `suspicious_binding` fires when `parameter_key` is outside `expected_parameters`, class
   publish is refused, and `acknowledgeWarnings: true` lets it through — all three asserted.
7. A bound formula and the equivalent hand-written expression produce an **identical**
   `compiled_plan`. This is the test that proves the feature adds no new semantics.
8. Publishing `v2` of a named formula leaves an already-published class's plan and recorded
   version untouched.
9. Copy-on-grant carries the compiled plan and the provenance fields; the tenant copy
   resolves nothing at runtime.
10. All seven seeded formulas compile and publish in the migration.
11. A workbook with no `named_formula` column loads unchanged.

## 9. Out of scope

- Runtime execution of the plan — **QCE2**.
- Baseline operators (`baseline_avg`, `baseline_sd`, `zscore`, `delta_ratio`) — **QCE4**,
  next. Do not add operators here, but do not design anything that makes adding them harder.
- Template v4 — QREC0.
- Anything under `frontend/`. Report the endpoint and payload shapes the picker needs.

## 10. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  measured by stashing back and running.
- Full migration chain from empty; down path named with `undoMigrationNamed`.
- **Seed before you migrate.**
- Report: commit SHA, test counts, which of the seven seeded formulas compiled and which did
  not with the reason, and anything not implemented.

# QCE4 — baseline operators

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/baseline-operators`

Migration timestamp above everything on `main` — four branches landed, so check.

Read `docs/ai/analysis/itdc-coverage-analysis.md` §2 and §3 before starting. They are now in
the repo and they are the justification for this task.

---

## Why this is the highest-value task on the board

Every logic column in ITDC's predictive-maintenance section is one of two shapes: a ratio
normalised by load, or **a comparison against the machine's own recent history**.

The first already works — a series-valued formula over the existing registry.

The second does not. D34 compares a signal to a **fixed threshold**. Nothing in the stack can
say "versus this machine's last 90 days". Four operators close that, and seven of the nine
ITDC use cases stop needing a model and start needing a published KPI.

No new rule kind. No new engine. Four entries in the existing registry.

## 1. The operators

```
baseline_avg(series, window)      mean over a trailing window, EXCLUDING the current period
baseline_sd(series, window)       standard deviation over the same window
zscore(series, window)            (current − baseline_avg) / baseline_sd
delta_ratio(series, w1, w2)       mean over w1 ÷ mean over w2
```

`delta_ratio` is the 7-day-versus-90-day shape ITDC uses repeatedly.

**Units and kind, decided at compile time by the existing inference:**

| operator | result unit | result kind |
|---|---|---|
| `baseline_avg` | same as input | series |
| `baseline_sd` | same as input | series |
| `zscore` | **dimensionless** | series |
| `delta_ratio` | **dimensionless** | series |

`zscore` and `delta_ratio` returning dimensionless is the part the compiler must get right —
a ratio of two quantities in the same unit has no unit, and a threshold rule on a `zscore`
must not be unit-checked against the source signal. Assert it.

**`window` is a duration literal**, the same vocabulary the existing operators use for their
windows. Do not invent a second duration syntax. If the current operators take window
differently, match them and say so in the report.

**The current period is excluded from the baseline.** A baseline that includes the reading
being judged is partly a comparison against itself, and it damps exactly the excursion the
KPI exists to find. This is the single easiest thing to get wrong here. Test it directly:
a long flat history then one extreme reading — `baseline_avg` is unchanged by that reading,
and `zscore` is large.

## 2. `baseline_not_established` — the state, not a number

A baseline computed over too little history is noise presented as authority. Same rule as
D20's residual bands.

**Below 14 days of history in the window, the operator does not return a number.** It yields
the readiness state `baseline_not_established`, which is its own state — never `0`, never
`null` silently, and never rendered as "normal".

Readiness already has four states (`ready` / `blocked` / `not_configured` /
`not_available`) with reasons (`unbound` / `stale` / `no_readings` / `mapping_required`).
**Add `baseline_not_established` as a reason**, resolving to `not_available`. Do not invent
a fifth state.

The 14-day minimum is a platform default. Make it a named constant with the reasoning in a
comment, not a literal scattered across four operators.

**Tests:** 13 days of history → `baseline_not_established`; 15 days → a number; a KPI in that
state renders as unavailable with the reason, and **a threshold rule on it does not fire**.
That last one matters most — a rule that fires on a non-established baseline is worse than no
rule.

## 3. Dirty windows — a baseline learned during a fault encodes the fault as normal

This is the defect I recorded against D20 and it applies identically here. If a machine was
degrading through the baseline window, the baseline is the degraded behaviour, and the KPI
reports "normal" for the rest of the machine's life.

**Exclude from the baseline window any period with a raised alert on the same signal, or an
open work order on the machine.**

- If exclusion drops the remaining history below the 14-day minimum →
  `baseline_not_established`. Correct, and better than a confident wrong number.
- Report what the platform can actually see today. Alerts exist. **If work orders do not,
  implement the alert exclusion, state plainly that the work-order half is not wired, and do
  not stub it** — a stub that silently excludes nothing is worse than an absence that is
  documented.

**Tests:** a window containing a raised alert excludes that period, and the resulting
baseline differs from the unexcluded one; exclusion that drops below the minimum yields
`baseline_not_established`.

## 4. Composition

These are ordinary registry operators. They compose with everything QCE1 and QCE1.1 built —
arithmetic, `#formula_key` composition, named formulas from QCE3.

The ITDC cross-sensor risk score is arithmetic over several z-scores with a count of how many
exceed 2. **Verify that composes today.** If it does not, report what blocks it rather than
adding an operator to make it work.

**Tests:** `zscore(...) > 2` compiles; a formula summing three z-scores compiles and is
dimensionless; a named formula from QCE3 whose expression uses `zscore` publishes.

## 5. Out of scope

- Runtime execution — **QCE2**. This task is the registry, the inference and the readiness
  state. If the operators cannot be exercised without QCE2, say so and test at the compile
  and plan level only.
- Categorical operators — **QCAT1**.
- Authoring the ITDC KPIs as library content — that is content work for the library team once
  this ships.
- Anything under `frontend/`.

## 6. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  measured on a throwaway commit or a second worktree — **not by stashing**.
- Full migration chain from empty; down path named with `undoMigrationNamed`.
- **Seed before you migrate.**
- Report: commit SHA, test counts, how `window` is expressed and whether it matched the
  existing operators, whether work-order exclusion was wirable, whether the cross-sensor risk
  score composes today, and anything not implemented with the reason.

# QCE2 — the runtime evaluator

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/calc-runtime`

Rebase onto `feature/baseline-operators` if QCE4 has not merged. Migration timestamp above
everything on `main`.

---

## What this is

QCE1 turns an expression into a `compiled_plan`. QCE3 lets that plan come from a named
formula. QCE4 added baseline operators. **Nothing executes any of it.** Every KPI in the
platform currently compiles and returns nothing.

QCE2 executes a `compiled_plan` over a time window against `telemetry_reading` and returns
a result. That is the whole task.

## 1. The result is never a bare number

This is the spine of the task and the thing to get right before anything else.

Three times now the platform has had a defect of the same shape: an absence rendered as a
value. D20's unlearned band reporting no anomalies. D28's replay passing vacuously with no
history. QCE4's baseline over 13 days. Each time the fix was the same — **make the absence a
state**.

So the evaluator returns an envelope, always:

```ts
{
  value: number | number[] | null,
  unit: string,
  resultKind: 'scalar' | 'series',
  window: { from, to },
  readiness: 'ready' | 'blocked' | 'not_configured' | 'not_available',
  reason?: 'unbound' | 'stale' | 'no_readings' | 'mapping_required'
         | 'baseline_not_established' | 'insufficient_coverage' | 'undefined_result',
  coverage: { expected: number, actual: number, ratio: number }
}
```

`value` is `null` whenever `readiness !== 'ready'`. **Never 0, never NaN, never an empty
array standing in for "nothing happened".** A caller that ignores `readiness` and reads
`value` gets `null` and fails loudly rather than rendering a confident wrong number.

No endpoint, renderer or test may produce a number without its readiness. If that makes a
signature awkward, the signature is wrong.

## 2. Execution

- One executor per operator, in a **closed registry** keyed the same way the compiler's
  operator registry is. Never `eval`, never `new Function`.
- **A test asserts every operator in the compiler registry has an executor**, and fails
  naming any that does not. Same pattern as QGRANT0's inventory: adding an operator without
  an executor must break the build, not production.
- Plan nodes execute bottom-up. A `#formula_key` reference resolves to its own plan and
  executes first; the compiler already refused cycles, so assume a DAG but **assert it**
  rather than trusting it.
- The declared result unit from the plan is carried onto the envelope. The evaluator does
  **not** re-derive units — that was decided at compile time and re-deriving invites drift.

## 3. Reading telemetry

One query per `(imei, signal, window)`, never per reading. Bound `source_timestamp` on both
ends so partition pruning works — QPART1 exists for this.

**Report the plan.** Run `EXPLAIN` on the generated query for a 12-hour window and state how
many partitions it touches. If it is all of them, the query is wrong and pruning is not
happening; say so rather than shipping it.

A plan referencing several signals reads them in one pass where the window is shared. Do not
issue one round trip per signal per widget — the machine page (D29) renders many widgets and
that is the shape that makes it slow.

## 4. Windows, gaps and coverage

**Windows are rolling from the evaluation instant** unless the plan declares calendar
alignment. Say which the plan currently supports; do not invent a second mechanism.

**Coverage is computed, not assumed.** Expected reading count comes from the signal's
declared cadence; actual is what the window holds.

- `coverage.ratio < 0.5` → `insufficient_coverage`, `value: null`. Make the threshold a
  named constant with the reasoning beside it, not a literal.
- No readings at all → `no_readings`. Distinct from thin coverage; the existing readiness
  vocabulary already separates them and Q08S s3 relies on the distinction.
- Latest reading older than the signal's `stale_after_seconds` → `stale`.

**Gaps are not zeros.** A missing reading is absent, not a measurement of nothing. `avg`
over a window with gaps averages what is there and reports coverage; it does not
interpolate, and it does not treat a gap as 0. State in the code comment that no
interpolation happens, because the next person will assume it does.

## 5. Arithmetic that has no answer

- Division by zero → `undefined_result`, `value: null`. Not `Infinity`, not `null` silently.
- `baseline_sd` of a constant series is 0, so `zscore` divides by zero → `undefined_result`.
  A perfectly steady signal is the common case on a healthy machine, so this will fire in
  normal operation and must read as "no answer", never as an anomaly.
- A series operator over an empty series → `no_readings`, not an empty array.

**Tests for each**, and each must assert the reason code, not just that it did not crash.

## 6. The endpoint

```
GET /api/v1/equipment/:sourceSystem/:externalId/kpis
GET /api/v1/equipment/:sourceSystem/:externalId/kpis/:formulaKey?from=&to=
```

Tenant-scoped, under the tenant's own copies — never platform catalog rows. RLS applies;
this reads `telemetry_reading` through the parent.

The list endpoint returns every KPI the tenant's class copy declares, each with its
envelope. **A KPI that is not ready still appears**, with its readiness and reason. The
machine page must be able to show "not configured" next to a tile rather than omitting it —
a missing tile is indistinguishable from a tile nobody authored.

## 7. Performance

Report, measured not estimated, against a seeded database:

- one KPI over a 12-hour window
- twenty KPIs for one machine, as the machine page would ask
- the partition count from §3

If twenty KPIs take more than about two seconds, stop and tell me the breakdown rather than
optimising. That is a design conversation — caching, materialisation, or a different read
shape — and it is mine to decide.

## 8. Out of scope

- Caching or materialising results. Evaluate on demand; measure first.
- Scheduled evaluation and alert firing — the alert runner already exists and QALERT2 just
  corrected it. Do not wire them together here.
- The machine page itself — QPAGE1.
- Anything under `frontend/`. Report the response shape.

## 9. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  measured on a throwaway commit or a second worktree — **not by stashing**.
- Full migration chain from empty if a migration is needed; down path named with
  `undoMigrationNamed`.
- **Seed before you migrate.**
- Report: commit SHA, test counts, the §7 numbers, the partition count from §3, which
  window alignments the plan supports, and anything not implemented with the reason.

# QCE2.1 — `series` means a series

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/series-evaluation`

Rebase onto whatever of `feature/calc-runtime` and `feature/signal-freshness` has not merged.
Migration timestamp above everything on `main` if one is needed — probably none.

---

## Why

QCE1 types a formula as `scalar` or `series` at compile time. QCE2 returns a number for
both. The compiler declares a shape the runtime does not deliver, which is the same defect
class we have spent the week removing — a declared state that is not honoured.

It surfaces at QPAGE1: a chart widget asks for twelve hours and receives one point.

**Two things were conflated when this was deferred.** A *bucketed series of the signal* is one
SQL query with `date_trunc` — no materialisation, no caching, and it is what a chart needs. A
*rolling baseline recomputed per bucket* is genuinely expensive. The first is this task. The
second stays out.

## 1. `series` returns points

```ts
value: number | { t: string, v: number | null }[] | null
```

- `resultKind: 'scalar'` → `number | null`, unchanged.
- `resultKind: 'series'` → an array of points, ascending by `t`, `t` as ISO 8601 UTC.
- **A plan declaring `series` that produces a scalar is a failure**, not a convention. Throw,
  name the formula key, and test it. The whole point is that the declaration is honoured.

**A bucket with no readings is a point with `v: null`, not a missing point and not 0.** A
chart must be able to draw a gap. Omitting the bucket makes a gap look like compressed time;
zero makes a silent machine look like a reading of zero. Same rule as everywhere else: the
absence is represented, never substituted.

## 2. Bucket size — one deterministic rule

Target **roughly 120 points** per window, snapped to a human unit:

```
1m, 5m, 15m, 30m, 1h, 3h, 6h, 12h, 1d
```

Pick the smallest unit in that ladder that yields ≤ 200 buckets for the window. A 12-hour
window gives 5-minute buckets (144); 7 days gives 1-hour (168); 30 days gives 6-hour (120).

The plan may override with an explicit bucket. An override producing more than **1000**
points is **refused**, naming the count — not truncated, because a silently truncated chart
is a wrong chart.

Put the ladder and the rule in one named function with the reasoning in a comment. It will be
read by whoever wonders why their chart has the resolution it has.

## 3. One query, bucketed in the database

`date_trunc` or an equivalent, with `source_timestamp` bounded on both ends so partition
pruning still works. **Not** fetching every reading and bucketing in Node — that moves a
window of raw rows across the wire to throw most of them away.

Report the partition count from `EXPLAIN` for a 12-hour bucketed query, as QCE2 did.

Aggregation inside a bucket uses the plan's own operator: a plan whose outer operator is
`avg` averages within each bucket, `max` takes the max. State what you do when the outer
operator has no meaningful per-bucket reading — `last`, say — rather than guessing silently.

## 4. Baseline operators stay single-valued

`baseline_avg`, `baseline_sd`, `zscore`, `delta_ratio` return their value **at the window's
latest instant**, as QCE2 built them. They are not recomputed per bucket in this task.

**Document that in the envelope**, do not leave it to be inferred: a series plan whose outer
operator is a baseline operator returns a one-point series with that instant's value, and
says so. A caller charting it gets one point and knows why.

Recomputing per bucket is a later task if anyone needs it. Nobody does yet.

## 5. Alert-based dirty-window exclusion — the join, specified

`baselineExcludedRanges` exists, is tested, and nothing calls it. Work-order exclusion is
wired; alert exclusion is not, because the `alert_rule` scope join was not specified. It is
here.

A raised alert excludes its period from a baseline window when **both** hold:

**a. The rule applies to this equipment**, by its `appliesTo` scope:

| scope | applies when |
|---|---|
| `equipment` | the rule names this equipment |
| `plant` | this equipment's current placement is in that plant |
| `equipment-class` | this equipment's class matches |
| `account` | always, within the tenant |

**b. The rule's signal is the baseline's input signal.** A rule on oil pressure does **not**
dirty a coolant-temperature baseline.

Condition (b) is the one that matters. Without it, a single noisy alert anywhere on the
account blanks every baseline on every machine, and the whole feature reads as broken.

Exclusion is by the alert's raised-to-resolved interval. An alert still open at evaluation
time excludes up to now. If exclusion drops the remaining history below QCE4's 14-day
minimum, the result is `baseline_not_established` — already built, confirm it fires.

**Tests:** each of the four scopes, one that excludes and one that does not; a rule on a
different signal leaves the baseline unchanged; an open alert excludes to now; exclusion
below the minimum yields `baseline_not_established`.

## 6. Performance

Measure and report, as QCE2 did:

- one series KPI, 12-hour window, 5-minute buckets
- twenty widgets for one machine, mixed scalar and series
- the partition count

QCE2 measured 40 ms for twenty scalars. If twenty mixed widgets exceed about two seconds,
**stop and report the breakdown** rather than optimising. That is a design conversation.

## 7. Out of scope

- Caching or materialising. Measure first; QCE2's numbers say we do not need it.
- Baselines per bucket (§4).
- The page itself — QPAGE1.
- Anything under `frontend/`. Report the response shape, including the null-point convention,
  since the chart library has to handle it.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after, on
  a throwaway commit or a second worktree — **not by stashing**.
- Report: commit SHA, test counts, the §6 numbers, the partition count, the per-bucket
  aggregation decision from §3, and anything not implemented with the reason.

## Addendum — a test QCE2 signed off was proving the wrong thing

`test/kpi-evaluation.spec.ts`'s "division by zero" test used
`coolant_temp_c / (coolant_temp_c - coolant_temp_c)`. That expression is series-kind — a bare
signal minus itself, divided — not scalar, because nothing in it reduces the window to one
value. QCE2's runtime at the time only ever produced scalars, so the test passed, but it was
exercising "a series plan silently coerced to one number", not "a scalar formula whose
division is undefined" as its name claimed.

§1's "declares series, throws if it can't deliver" check is exactly what turned this up: the
corrected runtime refused the original expression outright, rather than quietly returning the
same wrong-for-the-right-reason answer. Fixed the test's formula to
`avg(coolant_temp_c) / (avg(coolant_temp_c) - avg(coolant_temp_c))` — genuinely scalar,
dividing by zero for the same reason — and kept the original assertion (`undefined_result`).
Recording this because a test we both signed off was quietly testing something adjacent to
its name, and the only reason it surfaced now is that `series` started meaning `series`.

---

# QCE5 — comparison operators and `count_exceeding`

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/comparison-operators`

**Stream B.** Touches `src/catalog/formula/` and the evaluator's plan walk. `operator-registry.ts`
is a shared file — **append entries, never reorder**. Do not touch `template-schema.ts`,
`CLASS_CONTENT_INVENTORY` or `src/catalog-import/`.

Drafted from the register entry and QCE4's own finding, at the user's instruction, because no
prompt had been written. The register said "after the library is loaded"; the user chose not to
wait.

---

## 0. Why

QCE4 reported that the ITDC cross-sensor risk score does not compose. Summing z-scores works;
**"count how many exceed 2" does not** — the grammar has no comparison operator and no
boolean-to-number cast. `test/baseline-operators.spec.ts` test 8 records the gap.

## 1. Comparisons yield a dimensionless 0 or 1

```
comparison := expression [ ('>' | '>=' | '<' | '<=') expression ]
```

- Lowest precedence, below `+`/`-`. **Non-associative**: `a < b < c` is refused — it reads as a
  range and means something else.
- Allowed wherever an expression is: a function argument, inside parentheses, at the root.
- **A new plan node, `compare`**, not new `binary` ops. An evaluator older than this task must
  throw on a stored plan it does not understand, never fall through to division.
- **Units:** both sides carry the same unit, with the literal polymorphism `+`/`-` already have
  (`coolant_temp_c > 105` is fine; `coolant_temp_c > oil_pressure_kpa` is refused). The result is
  `dimensionless`. Kind is `series` if either side is.
- **No `==` or `!=`.** Equality between continuous measurements is a coincidence, and state
  codes are categorical signals — QCAT1's.
- Bump `COMPILER_VERSION`: the plan shape changes.

## 2. `count_exceeding(series, threshold)`

Readings in the window **strictly above** the threshold — the same `>` as §1. Dimensionless.
The threshold carries the series' unit or is a literal, as `fraction_within`'s bounds do.

**No readings is `no_readings`, not 0.** Zero exceedances of nothing is not evidence of anything.

## 3. What stays refused

`count(x > 2)` — `count` counts readings, so it would count every point, above 2 or not. A
comparison is refused as a reducer's series argument, naming `count_exceeding`. QCE4's test 8
keeps passing, now for a stated reason.

## 4. Runtime

- Scalar evaluation: compare the two sides' values, 1 or 0.
- Series evaluation: per bucket, `null` if either side is.
- **The risk score**: a plan whose every series input sits under a baseline operator is
  evaluated once, at the window's end, and returned as a one-point array — QCE2.1 §4's
  exception for a baseline root, extended to arithmetic and comparisons over baseline roots.
  Anything else outside the bucketable shapes still throws, naming the formula.

## 5. Tests

- `(zscore(a, 90d) > 2) + (zscore(b, 90d) > 2) + (zscore(c, 90d) > 2)` compiles, dimensionless.
- Mismatched units refused; `a < b < c` refused; `==` refused.
- `count_exceeding` executor: strictly above; empty window → `no_readings`.
- End to end: the risk score evaluates to a count; a series comparison buckets to 0/1/null.
- The executor/operator registries still match exactly.

## 6. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after on a worktree
off `origin/main`, naming the base SHA. No migration.

---

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

---

# QGEO1 — site boundaries and inside/outside

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `feature/site-geofence`, stacked on QCAT1 (!70) — merge after it.

**Stream B.** Touches `plant` (a boundary column and its route), `src/catalog/formula/` and the
evaluator. Append to `operator-registry.ts`, never reorder. No npm dependency, no PostGIS.

Drafted at the user's instruction from `docs/ai/analysis/itdc-coverage-analysis.md` §4b. The
user chose a TypeScript point-in-polygon over PostGIS, which Railway's Postgres image lacks.

---

## 0. Why

`latitude` and `longitude` are two numeric signals today: enough to see a machine has not
moved, not enough to say it left its site. Fuel theft's strongest clause and ITDC case 5 need
inside/outside.

## 1. A site has a boundary

`plant.boundary jsonb NULL` — a GeoJSON `Polygon`: an outer ring, optional hole rings,
`[longitude, latitude]` positions, each ring closed and with at least four positions.

The database refuses a malformed one (a CHECK over an immutable validation function), so no
path can store a boundary the operators would then misread. Set with
`PUT /api/v1/equipment/plants/:id/boundary` under `equipment.write`, the same capability that
edits the site; `null` removes it.

## 2. Operators

| operator | result | meaning |
|---|---|---|
| `outside_site(latitude, longitude)` | dimensionless 0/1 | is the latest position outside the site |
| `fraction_outside_site(latitude, longitude)` | dimensionless | share of time outside, time-weighted |

- Both series arguments are signals by name and must share a unit.
- **Pairing:** a latitude reading takes the latest longitude reading at or before it, within
  five minutes. Unpaired readings are dropped — a position is both halves or nothing.
- Time-weighted as QCAT1 is: each position holds until the next.
- A point exactly on the boundary is **inside**. A site is drawn generously; a machine parked
  on the line has not left.
- Planar ray casting over longitude/latitude. Accurate at site scale, which is the only scale
  a site boundary has. No polygon crosses the antimeridian here; say so rather than handle it.

## 3. When there is no boundary

A machine with no site, or a site with no boundary, reads `not_configured`, reason
`site_boundary_not_set`. Never "inside" — an unfenced site is not a site the machine is in.
No positions in the window is `no_readings`.

## 4. Out of scope

- Map drawing — the UI's.
- Multi-polygon sites, distance-to-boundary, speed.
- Geofence alert rules — a threshold on `outside_site` already expresses one.

## 5. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after naming the
base SHA. Migration timestamp above `main`; down path named with `undoMigrationNamed`.
