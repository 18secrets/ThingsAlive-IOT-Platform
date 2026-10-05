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
