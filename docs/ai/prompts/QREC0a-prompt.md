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
