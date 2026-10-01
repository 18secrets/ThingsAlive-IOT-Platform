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
