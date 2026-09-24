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
