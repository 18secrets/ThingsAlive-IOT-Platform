# Test plan — Development

Everything below runs against the deployed Development environment. Nothing here needs the
console; all of it is Swagger or curl. Run in order — later cases depend on earlier ones.

```
API   https://api-development-154e.up.railway.app
Docs  https://api-development-154e.up.railway.app/api-docs
UI    https://frontend-ui-thingsalive-iot-platform-development.up.railway.app
```

**Record a result for every case.** A case that "seemed fine" and was not recorded is a case
nobody ran.

---

## 0. Before you start

| | |
|---|---|
| Accounts | one named platform account each — do not share logins; every row carries who loaded it |
| Platform sign-in | `POST /api/v1/platform/auth/sign-in` |
| Tenant sign-in | `POST /api/v1/auth/sign-in` — a different route; using the wrong one is the most common first failure |
| Capabilities needed | `catalog.write` to load and approve, `catalog.publish` to publish |

**Do not reuse the damaged classes.** `crane-400-kw` v1/v2, `diesel-generator` v1 and
`ex-1200v` v1/v2 are known bad and are being retired. Test with new content.

---

## 1. The import loop

### TC-01 — Upload a workbook twice
`POST /api/v1/platform/catalog/imports` with the same file, twice.
**Expect:** two batches, both usable. The checksum block is gone.
**If it refuses:** QIMP4 did not deploy. Stop and report.

### TC-02 — Discard an un-applied batch
`DELETE /api/v1/platform/catalog/imports/:id` on a batch you have not applied.
**Expect:** deleted.
Then try it on an applied batch. **Expect:** refused, with a reason.

### TC-03 — The same sensor on three classes
One workbook, three classes, all declaring `coolant_temperature`, same unit.
**Expect:** all three accepted. Each class ends with its own row.
This is the bug that was reported and did not exist — confirm it stays non-existent.

### TC-04 — Identical global rows
Put the same `sensor_capability` row in four times, byte-identical.
**Expect:** one capability, `deduplicated_rows: 4` in the diff, **nothing rejected**.

### TC-05 — Conflicting global rows
Same sensor and `parameter_key`, two different `canonical_unit` values.
**Expect:** `conflicting_capability`, naming both rows and both units. Hard error.

---

## 2. Sensor and category approval

### TC-06 — Proposed sensors appear
Upload a workbook naming three sensors the catalog does not have.
**Expect:** `proposedSensors` with three entries. Each lists **every** class that referenced
it — one entry per sensor, not one per row.

### TC-07 — Proposed categories
Include a sensor whose `category` does not exist.
**Expect:** `proposedCategories` listing the sensors that need it.

### TC-08 — Apply is refused while proposals are outstanding
`POST .../imports/:id/apply` without approving.
**Expect:** refused. Message names the count and the affected classes.
**This refusal is the feature.** If it applies anyway, stop and report.

### TC-09 — Approve in one call
`POST .../imports/:id/sensors` with `approveCategories` and `approve` together.
**Expect:** categories created first, then sensors, one transaction. Diff recomputes.
**No re-upload.** If you have to upload again, that is a failure.

### TC-10 — Approve a sensor whose category is not approved
Omit the category from `approveCategories`.
**Expect:** refused. No orphan sensor created.

### TC-11 — Check the unit before approving
Before approving, read `canonicalUnit` on every proposed sensor.
**Expect:** exactly what the workbook intended.
**Why:** a wrong unit here never fails. It silently unbinds every rule that touches that
signal, months later. This is a human check, not an automated one.

---

## 3. Diff warnings — the ones that were missed last time

### TC-12 — `incomplete_class`
Build a workbook where some of one class's signal rows will be rejected.
**Expect:** the diff carries `incomplete_class` with `signalsInWorkbook` and `signalsToApply`.
Apply without `acknowledgeWarnings`. **Expect:** refused, naming the class and both counts.
Apply with `acknowledgeWarnings: true`. **Expect:** succeeds, and it is recorded against you.

### TC-13 — `content_regression`
Re-upload a class with **fewer failure modes** than its published version.
**Expect:** `content_regression`, naming the previous version.
This is the `ex-1200v` case: six failure modes became zero and nothing said so.

### TC-14 — Per-class counts
For every class in the diff, compare `signalsInWorkbook` with `signalsToApply`.
**Expect:** equal. If they differ anywhere, **stop** — do not apply.

---

## 4. Publish and grant

### TC-15 — Draft is invisible
Apply a batch. Do not publish.
Check the client-facing routes. **Expect:** nothing. Draft content is invisible by design.

### TC-16 — Published is immutable
Publish a class. Try to edit it.
**Expect:** refused. A mistake can only be superseded by a new version.

### TC-17 — Verify before granting
Per class, confirm: signal count matches the workbook, failure-mode count matches, every
unit is the one intended, no class has 1 signal.
**Only then grant.**

### TC-18 — Grant copies everything
`POST /api/v1/catalog/entitlements`.
**Expect:** the tenant copy holds the class, its scenarios, its alert rules **and its
formulas**. Check `GET /api/v1/my-catalog/equipment-classes/:slug`.
**If formulas are missing:** QGRANT0 did not deploy. The machine page will be empty.

### TC-19 — Re-grant the same version
Grant the same class version again.
**Expect:** reported as already held. No duplicate, no silent nothing.

### TC-20 — Grant a newer version
Publish v2, grant it to a tenant holding v1.
**Expect:** **refused**, naming upgrade as a separate operation. Upgrade is not built yet.

---

## 5. Readiness — four states, told apart

Sign in as the tenant for this section.

### TC-21 — Unbound
A machine with a class requirement and no binding.
**Expect:** `not_configured` / `unbound`.

### TC-22 — Never any reading
Bound, zero readings ever.
**Expect:** `not_available` / `no_readings`, `lastReadingAt: null`.

### TC-23 — Went quiet
Bound, readings exist, newest older than `stale_after_seconds` (default 900).
**Expect:** `not_available` / **`stale`** — **not** `no_readings`.
**Why it matters:** `no_readings` sends a commissioning ticket; `stale` sends a maintenance
call. Getting this backwards sends the wrong team.

### TC-24 — Ready
Bound, newest reading inside the threshold.
**Expect:** `ready`, and `secondsSinceLastReading` present.

### TC-25 — Two signals, two thresholds
One machine, two signals with different thresholds, one quiet and one live.
**Expect:** they resolve independently in the same response.

### TC-26 — Coverage does not lie about staleness
`GET /api/v1/equipment/:sourceSystem/:externalId/coverage` on a machine switched off for days.
**Expect:** still **covered** — annotated with `lastReadingAt` and
`secondsSinceLastReading`, but not reclassified as missing. A quiet machine is not an
unconfigured one.

---

## 6. KPIs

### TC-27 — A scalar KPI
`GET /api/v1/equipment/:sourceSystem/:externalId/kpis/:formulaKey`
**Expect:** an envelope — `value`, `unit`, `window`, `readiness`, `reason`, `coverage`.

### TC-28 — Value is null when not ready
Any KPI whose readiness is not `ready`.
**Expect:** `value: null`. **Never 0, never NaN, never an empty array.**
This is the single most important assertion in the plan. If a not-ready KPI returns a
number, a customer will read it as a measurement.

### TC-29 — The list shows unready KPIs too
`GET .../kpis`
**Expect:** every KPI the class declares, including the unready ones with their reason. A
missing tile is indistinguishable from one nobody authored.

### TC-30 — A series KPI
A formula with `result_kind: 'series'`, 12-hour window.
**Expect:** an array of `{t, v}`, ascending, roughly 144 points at 5-minute buckets.

### TC-31 — Gaps are gaps
A machine with a reporting gap inside the window.
**Expect:** points exist for the gap with **`v: null`** — not omitted, not 0.

### TC-32 — Thin coverage
A window with under 50% of expected readings.
**Expect:** `insufficient_coverage`, `value: null`.

### TC-33 — Divide by zero
A KPI whose denominator is zero over the window.
**Expect:** `undefined_result`, `value: null`. Not `Infinity`.

### TC-34 — A baseline with too little history
A machine with under 14 days of readings, on a KPI using `zscore` or `baseline_avg`.
**Expect:** `baseline_not_established`. **Not 0, and not "normal".**

---

## 7. Alerts

### TC-35 — One spike does not fire
N=10, M=6. Nine normal readings, one far past the bound.
**Expect:** **no alert.**
This is the defect QALERT2 fixed. If a single spike fires, the old reduction is still live.

### TC-36 — Six of ten fires
Six of the last ten breached.
**Expect:** alert raised.

### TC-37 — Five of ten does not
**Expect:** no alert. Test the boundary both ways.

### TC-38 — Plain English
`GET /api/v1/alerts/rules`
**Expect:** "Fires when at least 6 of the last 10 readings rise above…" — readable by
someone who did not author it.

---

## 8. Negative tests on authoring

These are the refusals that keep the library trustworthy. Each must **fail**.

| | Attempt | Expect |
|---|---|---|
| TC-39 | Create a class through the API with a signal whose unit is null | refused |
| TC-40 | Create a scenario with `required_signals: []` | refused |
| TC-41 | Publish a class with zero signals | refused |
| TC-42 | Bind a named formula role to a signal of the wrong dimension | refused at publish, naming role, signal, expected and actual |
| TC-43 | Bind a role to a signal outside `expected_parameters` | `suspicious_binding`, refused unless `acknowledgeWarnings: true` |
| TC-44 | Publish a named formula whose expression does not compile | refused |
| TC-45 | Set `display_unit` different from the compiled unit | refused — no conversion exists |
| TC-46 | `chart_type: 'line'` on a scalar formula | refused |
| TC-47 | Send a reading older than 24 months | refused, not silently dropped |
| TC-48 | Send a reading for a month with no partition | fails loudly |

TC-39 to TC-41 exist because `crane-400-kw` was written through the API with a null unit and
no required signals, and nothing stopped it. One validator now covers both paths — prove it.

---

## 9. Reporting

One row per case:

| TC | Pass / Fail | Actual | Who | When |
|---|---|---|---|---|

For a failure, include: the request, the full response body, and the time — so the API log
can be found with `railway logs --http --status ">=400" --lines 50`.

**Do not fix anything you find.** Report it. A fix applied during testing is a fix nobody
reviewed.
