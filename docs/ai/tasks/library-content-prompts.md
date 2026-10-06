# Library content prompts

Tasks that shape what the equipment library holds — QREC0a, QREC0b, QREC0c. Each task is
recorded as it was given, followed by the corrections settled before implementation, so the
prompt and what was built can be read side by side.

---
# QREC0a — library content structure, and template v4

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/library-content-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/library-content`

Migration timestamp above `1758090000000-SignalFreshness`. Check `main` — four MRs just
landed.

QREC0 was one row in the register carrying three unrelated risks. This is the first of
three: **content structure and the template**. Page layout and the site class are QREC0b;
visuals and object storage are QREC0c. Do not build either here.

---

## Why now

The library team is loading classes today. Everything they author lands in a shape we then
have to live with, because published versions are immutable. There are **nine class
versions in Development and four are about to be retired** — this is the cheapest moment
this change will ever be, and it gets more expensive every week.

## 1. Failure modes and recommendations become rows

`equipment_class_profile.failure_modes` is `jsonb`. That was fine when nothing referenced
it. It is not fine now:

- a recommendation has to point at a failure mode, and jsonb has no identity to point at
- the import diff counted `failure_modes` as a blob, which is why **`ex-1200v` v2 shipped
  with `[]` and nothing said so**
- copy-on-grant carries rows; a blob rides along silently or not at all

Two tables:

```sql
equipment_class_failure_mode (
  id, equipment_class_slug, class_version,
  code,                 -- stable, snake_case, unique within (class, version)
  name, description,
  severity,             -- the existing vocabulary; do not invent a second one
  signals text[],       -- which declared signals indicate it
  created_at )

equipment_class_recommendation (
  id, equipment_class_slug, class_version,
  failure_mode_code,    -- FK by (class, version, code)
  action,               -- what a person does
  urgency,
  estimated_hours numeric NULL,
  required_parts jsonb NULL,
  created_at )
```

**A recommendation must name an existing failure mode on the same class version.** A
dangling `failure_mode_code` is refused at publish, naming both.

**A failure mode naming a signal the class does not declare is refused at publish**, naming
the signal. Same rule QREC0c will apply to visual anchors, and the same reason: content that
references something absent is a defect, not a draft.

### Migrating the existing jsonb

Nine class versions. Convert in the migration, row per entry, `code` slugified from the
entry's existing name where it has none. **Assert the count matches before dropping the
column** and raise if it does not — the lesson from QPART1's row-count check.

Keep the `failure_modes` column, deprecated and no longer read, until QREC0c. Dropping it
in the same migration that populates its replacement leaves no way back if the conversion
is wrong on a row we have not looked at.

## 2. KPI presentation metadata (D30)

`equipment_class_formula` gains:

```sql
display_unit      text NULL      -- what the UI shows; the compiled unit stays authoritative
target_value      numeric NULL
target_direction  text NULL      -- 'above' | 'below' | 'band'
target_upper      numeric NULL   -- band only
comparison_basis  text NULL      -- 'target' | 'fleet' | 'own_baseline' | none
default_window    text NULL      -- '24h', '7d', 'today', 'mtd' — QCE2's vocabulary, not a new one
chart_type        text NULL      -- 'line' | 'bar' | 'gauge' | 'number'
```

**`display_unit` must be convertible from the compiled unit or it is refused at publish.**
The platform has never done unit conversion — QCE3 established that dimension *is* unit — so
in practice this means they must be equal. Say so in the refusal message rather than
implying a conversion that does not exist, and if you implement any conversion at all, say
exactly which pairs.

`default_window` must be a value QCE2 accepts. A window the evaluator will reject is refused
at publish, not discovered on a page.

`chart_type: 'line'` on a `scalar` formula is refused — you cannot chart a single number
over time. `'number'` or `'gauge'` on a `series` formula is allowed; it renders the latest
point.

## 3. Forecast declarations (D40)

The library declares which signals are worth forecasting. Nothing forecasts yet — QML1 does
— but the declaration is content and belongs here.

`equipment_class_sensor_requirement` gains:

```sql
forecast_enabled        boolean NOT NULL DEFAULT false
forecast_horizon_hours  integer NULL
```

Default false. **This is the control that keeps QML1 affordable**: 500 machines × every
signal is the arithmetic that broke the budget in D40; 500 × three declared signals does not.
Put that reasoning in the column comment, because the temptation to default it true will
come from someone who has not read D40.

`forecast_horizon_hours` without `forecast_enabled` is refused.

## 4. Template v4 — one bump, everything at once

This is the bump that was deferred three times. It carries:

| sheet | column | source |
|---|---|---|
| `sensor_capability` | `sensor_slug` | QIMP5 added it optional — now primary, name becomes the fallback |
| `signal` | `stale_after_seconds` | Q08S s3 |
| `signal` | `forecast_enabled`, `forecast_horizon_hours` | §3 |
| `formula` | `named_formula`, `named_formula_version`, `bindings` | QCE3, optional → documented |
| `formula` | the seven presentation columns | §2 |
| **`failure_mode`** | new sheet — `class_slug`, `code`, `name`, `description`, `severity`, `signals` | §1 |
| **`recommendation`** | new sheet — `class_slug`, `failure_mode_code`, `action`, `urgency`, `estimated_hours` | §1 |

**v3 workbooks keep loading.** The parser accepts both; a v3 file gets the defaults and a
diff note saying which v4 capabilities it is not using. The library team has work in flight
and must not have it invalidated.

Regenerate the downloadable template with the example rows filled in, as QIMP1 intended —
a blank shell teaches nothing.

## 5. Copy-on-grant

The two new tables are class content. Add them to `CLASS_CONTENT_INVENTORY` as `copy`.

QGRANT0's audit test will fail until you do. **That is the mechanism working** — do not
special-case it.

The new columns on existing tables ride along with those tables' existing disposition; state
in the report which ones that is, having checked rather than assumed.

## 6. Tests

1. A recommendation naming a failure mode that does not exist on that class version →
   refused at publish, naming both.
2. A failure mode naming an undeclared signal → refused, naming the signal.
3. The jsonb migration converts all nine versions; the count assertion fires on a seeded
   mismatch. **Seed before you migrate.**
4. `display_unit` not equal to the compiled unit → refused, message states no conversion exists.
5. `default_window` not in QCE2's vocabulary → refused at publish.
6. `chart_type: 'line'` on a scalar → refused. `'number'` on a series → allowed.
7. `forecast_horizon_hours` without `forecast_enabled` → refused.
8. A **v3 workbook** loads unchanged, gets defaults, and the diff notes the unused v4 columns.
9. A **v4 workbook** with both new sheets applies, and the rows land in both tables.
10. Copy-on-grant carries failure modes and recommendations to a tenant copy.
11. The inventory test passes with the two new tables listed.

## 7. Out of scope

- Page layout, widget ordering, the site class — **QREC0b**.
- `equipment_class_visual`, anchors, object storage — **QREC0c**.
- Surfacing recommendations to a tenant — **QPAGE1**.
- Running forecasts — **QML1**.
- Anything under `frontend/`. Report the new response shapes.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after, on
  a throwaway commit or a second worktree.
- Full migration chain from empty, **and** against a database seeded with the nine class
  versions as they exist in Development. Down path named with `undoMigrationNamed`.
- Report: commit SHA, test counts, how many failure-mode and recommendation rows the
  migration created per class version, which existing tables' dispositions the new columns
  inherited, and anything not implemented with the reason.

### Settled before implementation (2026-10-05)

The prompt above was written from the register rather than the code; these answers
supersede it where they differ.

1. **§2 already existed.** QCE1's `1758010000000-FormulaCompilerMetadata` shipped every D30
   column. Nothing renamed: `target_direction` keeps `higher_better`/`lower_better`/`band`/
   `none`, the band uses `target_min`/`target_max` (stricter than `target_upper`), the
   window is `aggregation_window`. Added only: `number` on the `chart_type` CHECK, `line`
   refused on a scalar, and the "no unit conversion exists" wording. Template v4 columns are
   named after the database columns. `fleet` and `own_baseline` do **not** join
   `comparison_basis` — nothing evaluates them; they go in when QCE2 can compute them.
2. **Failure mode columns.** `symptom` is kept (not renamed to `description`; no
   `description` column). `severity` nullable, checked against `SEVERITY_VALUES`, NULL for
   migrated rows (D32).
3. **Urgency vocabulary:** `immediate` | `next_shift` | `next_service` | `monitor`. Severity
   is how bad; urgency is how soon. Different axes, different vocabularies.
4. **Four tables, not two:** `client_equipment_class_failure_mode` and
   `client_equipment_class_recommendation`, tenant-owned, RLS. `client_equipment_class.failure_modes`
   follows the platform rule: deprecated, still populated, not dropped here.
5. **`forecast_enabled` / `stale_after_seconds` on a signal row with blank criticality** — refused,
   naming the row. A setting that silently writes nowhere is worse than a refusal.
6. **Development content as the migration fixture** — approved: read-only SELECT, credentials
   from `railway variables` at run time only, content committed as a fixture, surprises reported.
7. **Naming:** `class_slug` + `class_version`, matching the sibling tables.

---

## QREC0b — page layout and the site class

# QREC0b — page layout and the site class

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/library-content-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/page-layout`

**Stream A.** Rebase onto `main` after !54 merges. Migration timestamp assigned **at rebase
time**, immediately before opening the MR — not when the branch is cut.

**Verified before writing this:** nothing on `main` holds page layout, widgets or a site
class. `plant` is the only place entity. Everything below is new.

---

## 0. The principle this follows

Same split as operators and compositions, and as named formulas and bindings:

> **A widget *type* is TypeScript — a deploy.
> A widget *instance and its position* are rows — content.**

So the vocabulary of widget types is closed and lives in code. Which widgets a class's page
shows, in what order, bound to what, is library content: authored, published, immutable,
copied on grant.

Getting this backwards means a new equipment class needs a frontend release. That is the
mistake `buildEquipmentModel(category)` made in the demo, and it is why the twin did not
scale.

## 1. The closed widget vocabulary

In code, one module, exported as a const array with a union type — the same shape as
`TENANT_ASSIGNABLE_PAGES`:

| type | binds to | serves |
|---|---|---|
| `kpi_number` | a `formula_key`, `result_kind: 'scalar'` | one value with its unit and target |
| `kpi_gauge` | a scalar `formula_key` with a target | value against its target band |
| `kpi_chart` | a `formula_key`, `result_kind: 'series'` | a bucketed series |
| `signal_chart` | a declared `signal` | the raw signal, bucketed |
| `readiness_list` | nothing | every declared signal with its readiness — the tier-0 twin |
| `schematic` | nothing | the 2-D twin. **QREC0c supplies the asset**; this declares the slot |
| `alert_list` | nothing | open alerts for this machine |
| `work_order_list` | nothing | open work orders |
| `service_due` | nothing | next service from the hours forecast |
| `failure_modes` | nothing | the class's failure modes with current status |
| `recommendations` | nothing | recommendations for raised failure modes |

**A type not in this list is refused at publish, naming it.** Adding a type is a deploy and
that is correct — it needs a renderer.

`failure_modes` and `recommendations` read the tables QREC0a created. If !54 has not merged,
stop and wait rather than duplicating them.

## 2. Equipment class layout

```sql
equipment_class_layout (
  id, class_slug, class_version,
  widget_type     text NOT NULL,      -- from the closed set
  widget_key      text NOT NULL,      -- stable, unique within (class, version)
  bound_to        text,               -- formula_key or signal; NULL where the type binds to nothing
  title           text,               -- override; NULL means the bound thing's own name
  position        integer NOT NULL,   -- order within the page
  size            text NOT NULL,      -- 'small' | 'medium' | 'large' | 'full'
  created_at
)
```

Unique on `(class_slug, class_version, widget_key)` and on
`(class_slug, class_version, position)`.

**Refused at publish**, each naming what and where:

- a `widget_type` outside the closed set
- `bound_to` naming a formula or signal the class does not declare
- `kpi_chart` bound to a `scalar` formula, or `kpi_number`/`kpi_gauge` bound to a `series` one
- `kpi_gauge` bound to a formula with no `target_value`
- `bound_to` set on a type that binds to nothing, or missing on one that requires it
- two widgets at the same `position`

These are the same refusals as everywhere: content that references something absent is a
defect, not a draft.

**A class with no layout rows is valid.** It falls back to a `readiness_list` plus every
declared KPI in `kpi_number` form, ordered by formula key. Publishing is never gated on
authoring a layout — library growth would stall behind page design.

## 3. The site class (D30 part 3)

A site is not a bag of machines. It has its own page — aggregate KPIs, a machine list, its
own alerts — and that page is library content like any other.

```sql
site_class (
  id, slug, version, name, description,
  status, published_at, created_by, updated_at
)

site_class_layout (
  id, site_class_slug, class_version,
  widget_type, widget_key, bound_to, title, position, size, created_at
)
```

Same lifecycle as `equipment_class_profile` — draft → published, immutable once published.
Same closed vocabulary, with site-level meaning: `kpi_number` over the site's machines,
`alert_list` for the site, `work_order_list` for the site.

**`plant` gains `site_class_slug` and `site_class_version`, both nullable.** Null means the
platform default site class. Do **not** make it required — every existing plant would need a
value it has no basis for.

**Out of scope here:** aggregating a KPI across machines. QPAGE1 serves the page; this
declares it. If a site widget cannot be computed yet, that is QPAGE1's `not_available`, not
this task's problem.

## 4. Copy on grant

Both layout tables are class content. Add them to `CLASS_CONTENT_INVENTORY` as `copy`.

**QGRANT0's audit test fails until you do. That is the mechanism working** — do not
special-case it.

The tenant's copy is theirs. This task gives them two changes and no more:

- **hide** a widget — `hidden boolean NOT NULL DEFAULT false` on the tenant copy
- **reorder** — `position` is editable on the tenant copy

**Adding a widget is not in this task.** A tenant adding a widget bound to a signal they added
themselves is real and wanted, and it belongs with QPAGE1 where there is something to render
it.

**On a new class version:** class-origin widgets update; a widget the tenant hid stays hidden;
a tenant reorder is preserved and marked custom. **A deliberate change is never silently
reverted** — same rule as the twin's anchors.

## 5. Template v4

The template gains a **`layout`** sheet: `class_slug`, `widget_key`, `widget_type`,
`bound_to`, `title`, `position`, `size`.

v4 is QREC0a's bump and it has already landed. **Do not bump the version again** — add the
sheet as an optional sheet within v4 and say so in the task doc. A workbook with no `layout`
sheet is valid and gets the §2 fallback.

## 6. Tests

1. A widget type outside the set → refused, naming it.
2. `bound_to` naming an undeclared formula → refused, naming it.
3. `bound_to` naming an undeclared signal → refused.
4. `kpi_chart` on a scalar formula → refused. `kpi_number` on a series → refused.
5. `kpi_gauge` on a formula with no target → refused.
6. Two widgets at one position → refused.
7. A class with no layout publishes, and the fallback lists a `readiness_list` plus one
   `kpi_number` per declared KPI.
8. Copy-on-grant carries both layout tables; the inventory test passes.
9. A tenant hides a widget; a new class version does not unhide it.
10. A tenant reorders; a new class version preserves the order and marks it custom.
11. A plant with no `site_class_slug` resolves to the default site class.
12. A v4 workbook with no `layout` sheet loads and gets the fallback.
13. A v4 workbook with a `layout` sheet applies, and the rows land.

**Seed before you migrate** — tests 9 and 10 need a tenant copy that existed beforehand.

## 7. Out of scope

- Serving the page — **QPAGE1**.
- Aggregating KPIs across a site's machines — QPAGE1.
- Visuals, anchors, object storage — **QREC0c**.
- A tenant adding a widget — QPAGE1.
- Anything under `frontend/`. Report the shapes the console needs to render an editor.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks** — the DB suite
  shares one database.
- Migration timestamp assigned **at rebase**; `verify:migrations` clean; full chain from
  empty; down path named with `undoMigrationNamed`.
- Report: commit SHA, test counts with base SHA, the widget types you ended up with and any
  you think are missing, whether the fallback in §2 is computed or stored, and anything not
  implemented with the reason.

### Settled before implementation (2026-10-05)

1. **The §4 merge rule is a pure function** (`mergeTenantLayout`), not an upgrade path.
   Copy-on-grant still refuses a newer class version (QUPGRADE1's job); tests 9 and 10
   exercise the function. That is the better shape regardless: a merge rule that only
   exists inside an upgrade path cannot be tested on its own.
2. **`site_class` and `site_class_layout` are `exclude`, not `copy`.** Nothing grants a
   site class to a tenant, so nothing copies one. The prompt first listed the layout as
   `copy`; the inventory audit — which cannot see `site_class_layout`, since it keys on
   `site_class_slug` rather than `class_slug` — is exactly why that is now written down
   with a reason instead of left silently absent.
3. **The formula decides presentation; the layout only agrees with it.** `chart_type` is the
   authority, and `result_kind` decides only when `chart_type` is `none` (the column's
   default, "nobody declared one"):
   - `kpi_number` — `chart_type` `number`, or `none` with a scalar
   - `kpi_chart` — `line`/`bar`/`area`, or `none` with a series
   - `kpi_gauge` — `gauge`, or `none` with a scalar and a target
   The §2 fallback reads the same rule, so a series formula falls back to `kpi_chart`.
4. **One default site class, seeded by the migration, and no authoring routes.** It holds
   `machine_list` (added to the closed set), `alert_list` and `work_order_list`. **There are
   deliberately no routes for authoring site classes**: nobody has asked for a second one,
   and an authoring surface with one row and no user is speculation. A second site class
   is its own task.
5. **A target** is a `target_value`, or a band with both `target_min` and `target_max`.

The `layout` sheet is added **inside template v4**, not as v5 — v4 is QREC0a's bump, the
sheet is optional, and a workbook without it gets the computed fallback.
### Recorded at review (2026-10-05)

- **`'none'` is the "unset" sentinel for `chart_type`, deliberately.** The column is
  `NOT NULL DEFAULT 'none'` (QCE1, `1758010000000`); the presentation rule above reads
  `'none'` where it says "null". A sentinel the database enforces beats a nullable column
  that means the same thing — **do not "fix" this to NULL.**
- **The migration's widget-type CHECK is a literal list, not imported from code**, with a
  test that fails when the database and `WIDGET_TYPES` disagree. A committed migration that
  imports a list which will change is a migration whose meaning shifts silently under it.
  Adding a widget type now costs a migration — correct, because it is a vocabulary change.
- **The fallback page is computed, never stored.** A stored fallback is a second source of
  truth that goes stale the moment a formula is added.
- **A tenant reorder names every widget exactly once**, and marks moved widgets
  `position_custom`. A partial reorder is ambiguous and would have been a silent bug.
- **Missing widget types, queued as QREC0b.1 after QPARAM1:** `parameter_list` (needs
  QPARAM1) and `forecast_chart` (QREC0a's forecast declaration has nowhere to render).

---

## QPAGE1 — the composed page endpoint

# QPAGE1 — the composed page endpoint

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/library-content-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/composed-page`

**Stream A.** Starts after !56 (QREC0b) merges — it reads the layout tables. Migration
timestamp assigned **at rebase time**.

**Before writing anything**, read `docs/ai/schema-inventory.md` and the widget vocabulary in
`src/catalog/layout/widget-types.ts`. This task consumes what QREC0a and QREC0b built; if
something below contradicts what is there, **stop and say so** rather than reconciling it.

---

## 0. The rule this task must not break

> **The page endpoint composes. It does not compute.**

Every number on the page already has exactly one producer:

| widget | producer |
|---|---|
| `kpi_number`, `kpi_gauge`, `kpi_chart` | `KpiEvaluatorService` |
| `signal_chart` | `TelemetryWindowReader` |
| `readiness_list` | the readiness resolver (Q08S s3) |
| `alert_list` | `AlertService` |
| `work_order_list` | `WorkOrderService` |
| `service_due` | `ServiceService` |
| `failure_modes`, `recommendations` | the tenant's class copy (QREC0a) |
| `schematic` | QREC0c — not built; the widget returns `not_available` / `no_visual` |

**If this task computes a number itself, it has created a second source of truth** and the
page will disagree with the endpoint it came from. Where a producer cannot answer, the
widget carries that state — it does not get an answer from somewhere else.

## 1. The machine page

```
GET /api/v1/equipment/:sourceSystem/:externalId/page
```

Tenant-scoped. Returns the whole page in one call — **the console must not need a second
request per widget.** That is the entire reason D29 specifies a composed endpoint.

```ts
{
  equipment: { sourceSystem, externalId, name, classSlug, classVersion, plantId },
  layout: { fallback: boolean },
  widgets: [
    { widgetKey, widgetType, title, position, size,
      data: <shape per type>,
      readiness: 'ready' | 'blocked' | 'not_configured' | 'not_available',
      reason?: string }
  ]
}
```

- Hidden widgets are **excluded**. Order comes from the tenant's copy.
- **A widget that cannot be filled still appears**, with its readiness and reason. A missing
  tile is indistinguishable from one nobody authored — that was settled in QCE2 and holds
  here.
- `data` is `null` whenever `readiness !== 'ready'`. Never `0`, never `[]` standing in for
  "nothing happened".

## 2. One pass per producer, not one per widget

A page with twenty widgets must not make twenty round trips. Group by producer and ask once:

- **all** KPI widgets → one evaluator call for the set of formula keys
- **all** `signal_chart` widgets → one bucketed read for the set of signals
- alerts, work orders, service, failure modes → one call each

**Report the query count for a twenty-widget page.** If it is not roughly the number of
producers, say so rather than shipping it.

## 3. The site page

```
GET /api/v1/sites/:plantId/page
```

Same envelope. The site's layout comes from its `site_class`, or the default when the plant
names none.

**Site KPIs need an aggregation and it must be declared, not guessed.** Add to
`site_class_layout`:

```sql
aggregate text NULL   -- 'sum' | 'avg' | 'min' | 'max' | 'count'
```

**Required when `bound_to` is set; refused when it is not.** There is no default — an
unstated aggregation is a wrong number nobody can see is wrong. Averaging a fuel total and
summing a temperature are both silently plausible.

Aggregation covers **only machines whose own KPI is `ready`**. The widget reports
`machinesIncluded` and `machinesExcluded` beside the value. An average over machines that
could not be measured is fabricated.

If **no** machine is ready, the widget is `not_available` / `no_ready_machines`, value null.

`machine_list` returns each machine with its worst readiness and its open alert count — not
its KPIs. A site page that evaluates every KPI of every machine is the thing that will make
this slow.

## 4. Widget data shapes

Closed, one per type, in a module beside the vocabulary. A test asserts every type in
`WIDGET_TYPES` has a shape and a producer, and fails naming any that does not — the same
pattern as QCE2's executor registry and QGRANT0's inventory.

| type | `data` |
|---|---|
| `kpi_number`, `kpi_gauge` | the QCE2 envelope: `value`, `unit`, `window`, `coverage`, plus `target`, `targetDirection` |
| `kpi_chart` | the envelope with `value` as `{t,v}[]` |
| `signal_chart` | `{ signal, unit, points: {t,v}[] }` |
| `readiness_list` | `[{ signal, readiness, reason, lastReadingAt, secondsSinceLastReading }]` |
| `alert_list` | `[{ id, severity, raisedAt, signal, message, acknowledged }]` |
| `work_order_list` | `[{ id, status, title, assignedTo, dueAt }]` |
| `service_due` | `{ nextDueAt, hoursRemaining, basis }` |
| `failure_modes` | `[{ code, name, symptom, severity, signals, status }]` |
| `recommendations` | `[{ failureModeCode, action, urgency, estimatedHours }]` |
| `machine_list` *(site only)* | `[{ sourceSystem, externalId, name, readiness, openAlerts }]` |
| `schematic` | `null`, `not_available` / `no_visual` until QREC0c |

`failure_modes.status` is **derived, not stored**: a mode is `active` when an open alert
names one of its signals, otherwise `clear`. Say in the report how you determined it, and if
the alert does not carry enough to decide, return `unknown` rather than guessing `clear`.

## 5. Performance

Measure and report:

- a twenty-widget machine page, cold
- a site page over twenty machines
- the query count for each

QCE2 measured 40 ms for twenty KPIs. **If a page exceeds about two seconds, stop and report
the breakdown** rather than optimising. Caching and materialisation are a design
conversation, and they are mine.

## 6. Out of scope

- Visuals and anchors — **QREC0c**.
- A tenant adding a widget — after QREC0c, when there is something to add.
- `parameter_list` and `forecast_chart` — **QREC0b.1**, after QPARAM1.
- Any new computation. See §0.
- Anything under `frontend/`. Report the full response shape; the console builds the page.

## 7. Tests

1. A machine with a layout → widgets in the tenant's order, hidden ones absent.
2. A machine whose class has no layout → the QREC0b fallback, `layout.fallback: true`.
3. A KPI that is not ready → the widget appears, `data: null`, with its reason.
4. A `schematic` widget → `not_available` / `no_visual`.
5. Twenty widgets → the query count is near the producer count, not twenty.
6. A site page → the site class's layout; a plant naming none gets the default.
7. A site KPI with `aggregate: 'avg'` over three machines, one not ready → the average covers
   two, and `machinesIncluded: 2`, `machinesExcluded: 1`.
8. A site KPI where no machine is ready → `no_ready_machines`, value null.
9. A `site_class_layout` row with `bound_to` and no `aggregate` → refused at publish.
10. Every `WIDGET_TYPES` entry has a shape and a producer.
11. A failure mode whose signal has an open alert → `active`; otherwise `clear`.
12. RLS: a tenant cannot read another tenant's page. Write this one deliberately.

**Seed before you migrate.**

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Migration timestamp at rebase; `verify:migrations` clean; chain from empty; down path named.
- Report: commit SHA, test counts with base SHA, **the §5 numbers and query counts**, how
  `failure_modes.status` was derived, and anything not implemented with the reason.

### Settled before implementation (2026-10-05)

1. **Mixed classes on a site page are normal, not an error.** A machine whose class does
   not declare the bound key is excluded and counted; exclusions are reported separately
   as `notDeclared` and `notReady`. **Mixed units are refused, never converted**: the widget
   is `blocked` / `unit_conflict`, naming each unit and a machine that reported it. The
   platform has no conversion, and QCE3 settled that a dimension is its unit.
2. **`aggregate` is a database CHECK**, `(bound_to IS NULL) = (aggregate IS NULL)` plus the
   closed set — there is no publish path for site classes (QREC0b removed the authoring
   routes), and a rule with nowhere to run is not a rule. The seeded default satisfies it.
3. **`failure_modes.status` is derived through the rule, not the alert**: `alert_event` →
   `alert_rule` → the rule's `params.signal`. `active` when an open alert's rule watches
   one of the mode's signals; `unknown` when any open alert on the machine comes from a
   rule that names no signal (chain, fuel-loss, prediction) — it might be this failure,
   and `clear` would be a guess; `clear` otherwise. No column was added to the alert
   pipeline: that would be a schema change in the one task that must not compute.
4. **Performance is measured and reported, not optimised.** Two seconds is the stop line.
5. **Names are mapped, not renamed.** The prompt's `ServiceService` is
   `ServiceForecastService`; `docs/ai/schema-inventory.md` is on Stream B's
   `chore/two-stream-setup`, not yet on `main`. If either name is genuinely wrong that is
   a cleanup task of its own.

### Found while building (2026-10-05)

- **Two producers disagree about which devices a machine has.** The KPI evaluator reads
  `device_projection` (the legacy mirror); `SignalBindingService.coverage` — and so
  `readiness_list` and `machine_list` — reads `device_inventory` (claimed devices). A
  machine present in one and not the other shows KPIs `ready` beside signals
  `no_readings` on the same page. Pre-existing; not reconciled here, because choosing one
  is a decision about the producers, not about composing them.
- **`readiness_list` covers the class's sensor requirements**, which is what `coverage`
  reports — not every declared signal. A declared signal with no requirement row is not
  listed. Rows carry `componentScope`, because a composite machine has one row per
  component for the same signal.
- **`signal_chart` reads a 24-hour window**, each bucket's `avg` — the task names no
  window; the reader computes every aggregate and the caller picks one.
- **A site KPI over a series formula is `not_available` / `series_not_aggregated`** — the
  task defines aggregation for values, not for bucketed series.
- **`kpi-evaluator.service.ts` was not opened** (shared with Stream B until QPARAM1). The
  signal-readiness mapping the page needs is restated in `page-widgets.ts`; the evaluator
  should call it once QPARAM1 merges.
### Recorded at review (2026-10-05)

- **The query rule fired on the wrong metric, and QPAGE1 ships as measured.** Machine page:
  84 queries, of which 32 are data reads and 52 are transaction framing (each producer
  opens its own tenant transaction). Thirty-two reads for twenty widgets is about one per
  producer per signal, which is what §2 asked for. 127–163 ms and 217–311 ms are both an
  order of magnitude inside the two-second line.
- **QTX1 — shared-transaction producers — exists because the site page is linear in
  machines.** About 6 queries per machine (each machine's coverage, for `machine_list`):
  20 machines is ~218 queries and ~0.3 s; 200 machines is ~1,200 queries and seconds. **The
  forcing function is machine count, not widget count. QTX1 must land before any customer
  has a large site.** It touches every producer, the evaluator included — a cross-cutting
  change that does not belong inside a feature.
- **QFIX-DEVICES — next in Stream A, and it blocks the machine page reaching a customer.**
  The evaluator reads `device_projection`; coverage reads `device_inventory`. A machine in
  only one shows KPIs `ready` beside signals `no_readings` — two adjacent widgets that
  contradict each other, which is the second-source-of-truth failure §0 exists to prevent.
- **Migration chain timing.** `migration.spec.ts`'s chain test now has an explicit 30 s
  timeout like every other DB spec (a fixture change; it asserts the same thing). On
  Railway, the pre-deploy `migration:run` executes only *pending* migrations, so a deploy
  never replays the chain. The full chain (~3 s locally at 52) runs only against an empty
  database, which means tests and any new environment such as Staging. It is a test-time
  and new-environment cost, not a per-deploy one.

---

## QREC0c — visuals, anchors and asset storage

# QREC0c — visuals, anchors and asset storage

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/library-content-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/class-visuals`

**Stream A.** Touches `src/catalog/**` and a new `src/assets/**`. Does not touch
`kpi-evaluator.service.ts`. Migration timestamp assigned immediately before opening the MR,
after the last merge-in — `main`'s newest is `1758300000000`.

**Dependency that is not code:** an S3-compatible bucket must exist. See §1. The task can be
built and tested without it; it cannot be deployed without it.

---

## 0. What this completes

QPAGE1 serves a `schematic` widget that returns `not_available` / `no_visual`, because
nothing supplies a visual. This supplies one.

**Tier 0 only — the schematic.** A labelled image with 2-D hotspots, one per signal. It works
for **every** equipment class on day one: no model, no 3-D authoring, no asset pipeline
beyond storing an image. The 3-D tier is QTWIN1 and it is a later, separate task.

The reasoning, so nobody reorders it: **what makes a twin worth looking at is a marker that is
green, amber or red with a reason.** That comes from readiness, which is built. The geometry
is the least valuable part.

## 1. Object storage — the decision, and what Deepak must provide

**S3-compatible, configured entirely by environment.** Do not hard-code a provider.

```
ASSET_S3_ENDPOINT        ASSET_S3_BUCKET
ASSET_S3_ACCESS_KEY_ID   ASSET_S3_SECRET_ACCESS_KEY
ASSET_S3_REGION          ASSET_S3_PUBLIC_BASE_URL   (optional, for a CDN in front)
```

**Dependency approved by name: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.**
Nothing else.

**With no configuration the module starts and logs that assets are unavailable** — the same
shape as `LegacyDataSource`'s warning. A missing bucket must not stop the API booting; it
makes visuals `not_available`, and nothing else.

**Assets never go in Postgres.** A 5–50 MB file in a row is a bandwidth bill and a backup
problem. The database stores a key; the bucket stores bytes.

**Report, do not assume:** whether Development has these variables set, and if not, say so —
provisioning the bucket is Deepak's and the task ships either way.

## 2. Schema

```sql
equipment_class_visual (
  id, class_slug, class_version,
  tier            text NOT NULL,   -- 'schematic' only, for now. CHECK it
  asset_key       text,            -- object key; NULL until uploaded
  content_type    text,
  width_px        integer,
  height_px       integer,
  uploaded_by, uploaded_at, created_at
)

equipment_class_visual_anchor (
  id, class_slug, class_version,
  signal          text NOT NULL,   -- must be declared by the class
  hotspot_x       numeric NOT NULL,  -- percentage, 0–100
  hotspot_y       numeric NOT NULL,
  label           text,
  created_at
)
```

One visual per `(class_slug, class_version)`. Unique on
`(class_slug, class_version, signal)` — one anchor per signal.

CHECK `hotspot_x` and `hotspot_y` between 0 and 100. A percentage is resolution-independent;
pixels are not, and the image will be replaced.

**Refused at publish, naming what:**

- an anchor whose `signal` the class does not declare — **never a silent fallback**. The demo
  did `anchorParts[key] || anchorParts.engine_runtime`, so a new signal landed on the wrong
  part of the machine and nobody was told. A coolant temperature drawn on the fuel tank is
  worse than no diagram.
- an anchor on a class with no visual row
- `tier` outside the CHECK

**A class with no visual publishes normally.** Tier 0 is a valid published state, or library
growth stalls behind image authoring. This is the same rule as QREC0b's layout fallback.

## 3. Upload and read

```
POST   /api/v1/platform/catalog/equipment-classes/:slug/:version/visual/upload-url
GET    /api/v1/platform/catalog/equipment-classes/:slug/:version/visual
DELETE /api/v1/platform/catalog/equipment-classes/:slug/:version/visual
PUT    /api/v1/platform/catalog/equipment-classes/:slug/:version/anchors
```

- **Upload is a presigned PUT.** The API never streams the bytes — it returns a short-lived
  URL and the key it will record. The console uploads directly to the bucket. An API that
  proxies 50 MB uploads is an API that falls over on the fourth one.
- The upload URL is refused for a **published** version. Visuals are class content and
  published content is immutable.
- **Allowed content types are a closed set**: `image/png`, `image/jpeg`, `image/webp`,
  `image/svg+xml`. Anything else refused, naming it.
- `PUT .../anchors` replaces the whole anchor set in one call, validated as a set. A partial
  anchor update is ambiguous — the same reasoning as QREC0b's reorder.
- Guarded by `catalog.write`; publishing stays `catalog.publish`.

**Reading** returns a signed GET URL with a short expiry, or the CDN URL when
`ASSET_S3_PUBLIC_BASE_URL` is set. **Never return the bucket credentials or a raw endpoint.**

## 4. Copy on grant, and tenant divergence

**The asset stays platform-owned and shared.** One file serves every tenant with that class —
that is what keeps bandwidth flat and the cache warm. A tenant never gets its own copy of the
image.

**The anchor set is copied on grant and becomes the tenant's.** It is rows, not megabytes,
and it is the part that diverges.

Add `client_equipment_class_visual_anchor` to `CLASS_CONTENT_INVENTORY` as `copy`.
`equipment_class_visual` is `exclude` — the tenant reads the platform row, with its reason
recorded, exactly as QREC0b did for `site_class`.

**A signal the tenant added themselves has no anchor.** It goes to an **unplaced tray** —
returned by the read endpoint as `unplacedSignals`, listed beside the visual, positioned later
by the tenant. **Never auto-assigned to a nearby anchor.**

**On a new class version:** class-origin anchors update; a tenant-placed anchor is preserved
and marked `placement_custom`. A marker somebody deliberately positioned is never moved
silently. Build the merge as a **pure function**, as QREC0b did — QUPGRADE1 calls it later.

## 5. The widget comes alive

QPAGE1's `schematic` widget stops returning `no_visual` and returns:

```ts
{ imageUrl, width, height,
  anchors: [{ signal, hotspotX, hotspotY, label, readiness, reason, value, unit }],
  unplacedSignals: [{ signal, readiness, reason }] }
```

**Anchors render per machine, not per class.** A machine without that sensor fitted shows the
anchor with its `unbound` readiness, or not at all — decided by the same readiness the rest of
the page uses, read from the same producer. **This task computes no readiness of its own**;
QPAGE1's rule still holds.

A class with no visual still returns `not_available` / `no_visual`. Unconfigured storage
returns `not_available` / `assets_unavailable` — a different reason, because they are
different problems.

## 6. Out of scope

- 3-D, GLB, three.js — **QTWIN1**.
- The site twin — per-customer content, a different owner and a different tool.
- The hotspot placement editor itself — frontend. **Report the endpoint shapes it needs.**
- Resizing, thumbnails, or any image processing. Store what is uploaded.
- Anything under `frontend/`.

## 7. Tests

1. An anchor naming an undeclared signal → refused at publish, naming the signal.
2. An anchor with no visual row → refused.
3. `hotspot_x` of 101 → refused by the CHECK.
4. A class with no visual publishes normally.
5. An upload URL for a published version → refused.
6. A content type outside the set → refused, naming it.
7. `PUT /anchors` replaces the set; a removed anchor is gone.
8. Copy-on-grant carries the anchors; the inventory test passes with the new entries.
9. A tenant signal with no anchor appears in `unplacedSignals`, **not** on a nearby anchor.
10. A new class version preserves a tenant-placed anchor and marks it `placement_custom`.
11. With no `ASSET_S3_*` configured, the module starts and the widget reads
    `not_available` / `assets_unavailable`.
12. The read endpoint returns a signed URL, never credentials or a raw endpoint.
13. RLS: a tenant cannot read another tenant's anchors.

**Seed before you migrate** — test 10 needs a tenant copy that existed beforehand.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Migration timestamp assigned before the MR; `verify:migrations` clean; chain from empty;
  down path named.
- Report: commit SHA, test counts with base SHA, **whether Development has the `ASSET_S3_*`
  variables**, how you tested the S3 path without a bucket, the endpoint shapes the hotspot
  editor needs, and anything not implemented with the reason.

### Settled before implementation (2026-10-06)

1. **Upload is two steps.** `POST …/visual/upload-url` records only `pending_key` and
   returns a presigned PUT; `POST …/visual/confirm` with `{ width, height }` HEADs the
   object — it must exist, be the content type the URL was issued for, and be 1 byte to
   50 MB — and only then records `asset_key` and the dimensions the console measured. A key
   recorded at issuance is a row pointing at nothing the moment an upload fails, and
   nothing would ever notice. Until confirmed the visual reads `upload_pending` — a
   different problem from `no_visual` and from `assets_unavailable`. A publish with an
   unconfirmed upload is refused: published is immutable, so it would stay pending forever.
2. **An anchor's `value` is the newest non-empty bucket's `last`** from the same 24-hour
   bucketed read `signal_chart` already does — one call for all anchors, an existing
   producer, no new computation. Readiness and reason come from coverage.
3. **A tenant places anchors with `PUT /my-catalog/equipment-classes/:slug/anchors`**
   (`client-catalog.write`), replacing the whole set. Every anchor the tenant moved or added
   is marked `placement_custom`; one left exactly where it was keeps its flag.
4. **Forks share bytes; DELETE never removes an object.** Forking copies the visual row with
   the same `asset_key`. `DELETE` on a draft removes the row and its anchors and keeps the
   object, because a published version or a fork may share it. **Orphaned-object cleanup is
   deliberately not built here** — it is a separate concern, not a forgotten one.

Kept explicit: an anchor for a sensor the machine does not have **stays on the image** with
its `unbound` readiness. Hiding it would make a fitted sensor and an unfitted one look
identical.

### Built (2026-10-06)

- **Storage** (`src/assets/`): S3-compatible, configured only by `ASSET_S3_*`; half a
  configuration counts as none. Unconfigured, the API boots with a warning and every
  visual reads `assets_unavailable`. **Development has no `ASSET_*` variables on either
  service** (names checked, values never read) — provisioning the bucket is Deepak's.
- **How the S3 path is tested without a bucket:** presigned PUT and GET URLs are computed
  offline by the SDK and asserted for real (key, signature, 900 s expiry, no secret). The
  one network call — HEAD at confirm — goes through the `AssetStorage` interface and is
  faked in `test/class-visuals.spec.ts`. A second app booted with no configuration proves
  the unconfigured path. Nothing has been run against a real bucket yet.
- **Inventory:** `equipment_class_visual_anchor` is `copy` (to
  `client_equipment_class_visual_anchor`); `equipment_class_visual` is `exclude` with its
  reason — the image is shared, never copied. The prompt named the client table as the
  `copy` entry; the inventory lists platform tables by what happens to them, so the
  platform anchor table is the entry and the client table is where it lands.
- **A signal with no requirement row** has no coverage row, so its anchor or tray entry
  reads `not_configured` / `not_required` rather than a guessed readiness.
- **A presigned URL carries the access key ID** in `X-Amz-Credential` by design — it is
  the public half of the credential pair. The secret never leaves the server.

### Endpoints the hotspot editor needs

Platform authoring (`catalog.write`), all under
`/api/v1/platform/catalog/equipment-classes/:slug/:version`:

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `visual/upload-url` | `{ contentType }` (png, jpeg, webp, svg+xml) | `{ uploadUrl, key, method: 'PUT', headers, expiresInSeconds }` |
| POST | `visual/confirm` | `{ width, height }` | the read shape below |
| GET | `visual` | — | `{ classSlug, classVersion, state, tier, imageUrl, contentType, width, height, anchors: [{ signal, hotspotX, hotspotY, label }], unplacedSignals: string[] }` |
| DELETE | `visual` | — | 204 |
| PUT | `anchors` | `{ anchors: [{ signal, hotspotX, hotspotY, label? }] }` | the read shape |

`state` is one of `ready`, `no_visual`, `upload_pending`, `assets_unavailable`. The console
PUTs the file to `uploadUrl` with exactly `headers`, then calls `confirm`.

Tenant (`/api/v1/my-catalog/equipment-classes/:slug`): `GET visual` (`client-catalog.read`)
returns `{ classSlug, state, imageUrl, width, height, anchors: [{ …, placementCustom }],
unplacedSignals }`; `PUT anchors` (`client-catalog.write`) takes the same body as the platform's.

The page's `schematic` widget: `{ imageUrl, width, height, anchors: [{ signal, hotspotX,
hotspotY, label, readiness, reason, value, unit }], unplacedSignals: [{ signal, readiness,
reason }] }`.