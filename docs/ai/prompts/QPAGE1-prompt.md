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
