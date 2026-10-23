# Phase 1 — Manual Testing

Development environment. Demo tenant with seeded data. Backend only; UI as far as it is wired.

---

## 1. Before you start

Three things must be true. **If any is false, stop and tell Deepak — do not test around it.**

| | How to check |
|---|---|
| `main` is deployed | Railway → Githubrepo API → latest deployment is **SUCCESS**, not WAITING |
| Migrations ran | API boots; `/api/v1/health` returns 200 |
| Demo data is seeded | `GET /api/v1/equipment` returns **6** machines, EX-01 … EX-06 |

---

## 2. Scope

**Environment:** Development only. One tenant (`demo-construction`), one equipment class (`demo-excavator`), six seeded machines. The data is seeded, not a customer's.

**In scope — these are built and must be tested:**

| Area | What |
|---|---|
| Identity | sign-in, token revoke, roles, allowed tabs, scope per request |
| Tenant onboarding | provisioning, invitation, super admin |
| Sites and equipment | plants, equipment register, the site page |
| Devices | device inventory, signal bindings, binding as the device authority |
| Telemetry and readiness | the four readiness states and every reason |
| Calculation engine | formulas, targets, KPI evaluation, coverage |
| Alerts | M-of-N rule firing, severity, acknowledge |
| Work orders | raise, assign, complete |
| Availability | scheduled hours, day / week / month |
| Library | authoring, publish checks, immutability, grant and copy-on-grant |
| Composed page | machine page and site page in one call each |
| Failure modes | class failure modes and recommendations, active vs clear |
| Incidents | the read-only view |
| Parameters | the four scopes, most specific wins |
| Security | tenant isolation and row-level security |

**Out of scope — do not test, do not raise:**

| | Why |
|---|---|
| OEE Performance and Quality | phase 2 — QOEE1. Availability alone ships now |
| Incident ownership, escalation, SLA timers | phase 2 — the view is all that exists |
| 3-D twin, schematic images, hotspots | QTWIN1 / no S3 bucket |
| Data from the 1.0 system | `LEGACY_DB_*` not configured here |
| Bulk onboarding of an existing fleet | QONBOARD1, phase 2 |
| The other 16 equipment classes | library content not loaded |
| Frontend visual design, responsiveness, browser matrix | UI is wired for function, not finished |
| Load testing, concurrency, tuning | beyond the single latency check in T4 |
| Penetration testing | separate exercise, before go-live |
| Staging, production, backups, disaster recovery | those environments do not exist yet |
| Email and SMS delivery | notification transport is not wired |
| Mobile | no mobile client in phase 1 |

**The boundary in one line:** test whether the platform tells the truth about six machines. Anything about *how it looks*, *how fast it scales*, or *what it does with a real customer's fleet* is a later phase.

---

## 3. Access

| | |
|---|---|
| API base | `https://<api>.up.railway.app/api/v1` — get it from `railway domain --service "Githubrepo API"` |
| Console | `https://<frontend>.up.railway.app` — frontend preview service |
| Tenant | `demo-construction` |
| Super admin | the pending invitation created by the seeder — accept it to set your password |
| Platform admin | master admin account, for library and grant screens |

**Credentials are not in this document.** Get them from Deepak. Do not paste them into chat, tickets or screenshots.

---

## 4. The six machines — what each one is for

The seed builds one machine per state. **These are the test cases.** Every state the platform can be in is on one of these six screens.

| Machine | State | What you should see |
|---|---|---|
| **EX-01** | Healthy | All signals `ready`. KPIs inside target. Availability high. No alert. A 2-hour stop every Wednesday afternoon. |
| **EX-02** | Trending | `ready`. Coolant risen ~14 °C over 10 days, still under the 105 °C bound. **No alert yet** — this is correct. |
| **EX-03** | Breaching | 6 of the last 10 coolant readings above 105 °C. **One open high-severity alert.** Failure mode COOLANT_OVERHEAT shows `active`. |
| **EX-04** | Gone quiet | 60 days of history, nothing for 3 days. Reads **`stale`** — *not* `no_readings`. The difference matters. |
| **EX-05** | Newly commissioned | Plain KPIs `ready`. Both baseline charts **`baseline_not_established`** — 9 days is not enough history. |
| **EX-06** | Partly unbound | Hydraulic oil temperature and fuel level read **`not_configured` / `unbound`**. Everything else `ready`. |

---

## 5. Business scenarios

Test these as the person, not as a developer. Note the time and the machine for anything that looks wrong.

| # | Scenario | Pass means |
|---|---|---|
| B1 | Accept the invitation, set a password, sign in | You land on the console as client super admin |
| B2 | Open the site page | Six machines listed, each with its worst readiness and open alert count |
| B3 | Open EX-01 | Every widget filled; no blank tiles with no explanation |
| B4 | Open EX-03 | Open alert visible, with the signal, the value and when it was raised |
| B5 | Acknowledge the alert on EX-03 | State changes; who acknowledged and when is recorded |
| B6 | Raise a work order from that alert | Work order appears on the machine, linked to the alert |
| B7 | Assign the work order, then complete it | Status moves; the alert stays separate from the work order |
| B8 | Open EX-04 | Says the machine has gone quiet and **when it last reported** |
| B9 | Open EX-06 | Names **which** signals are not configured — not just "incomplete" |
| B10 | Availability for one machine, day / week / month | Three different numbers, each with its scheduled hours |
| B11 | Create a role, pick its tabs, assign a user | Role saves. **Saving must not fail** — this was a live defect |
| B12 | Change a parameter at equipment scope | New value takes effect for that machine only, not the whole class |
| B13 | Open the incidents view | Machines with open alerts, each with its open work orders and worst severity |
| B14 | Sign in as a non-admin role | You see only the tabs that role allows |

---

## 6. Technical scenarios

| # | Scenario | Pass means |
|---|---|---|
| T1 | Sign in, use the token, revoke it, reuse it | Revoked token is refused |
| T2 | Call any tenant endpoint with another tenant's id | Refused. **Row-level security is the backstop — test it deliberately** |
| T3 | `GET /api/v1/equipment/:system/:id/page` | **One call returns the whole page.** No second request per widget |
| T4 | Same call — check latency | Under ~500 ms for a machine page. Report the number if not |
| T5 | Read any widget that is not ready | `"value": null` with a `readiness` and a `reason`. **Never `0`, never `[]`** |
| T6 | Check the three machine readiness states appear | `ready`, `not_configured`, `not_available` — across the six machines. (`blocked` needs a site KPI over mixed units, which the demo does not have; it is covered by automated tests) |
| T7 | EX-03's alert | Raised by the rule engine with 6 of 10 readings past the bound, not inserted |
| T8 | A machine with no shift schedule | Availability returns `no_shift_schedule`, value null |
| T9 | Try to edit published library content | Refused by the database, not just the UI |
| T10 | Grant a class to the tenant | A **copy** is created; editing the copy does not change the platform original |
| T11 | Site page PUNE-01, over all six machines | Aggregate KPIs report `machinesIncluded` and `machinesExcluded` — EX-04 excluded as stale, EX-06 also excluded from fuel |
| T12 | Site page PUNE-02 (no machines) | Every site KPI reads `no_ready_machines`, value null — not 0 |

---

## 7. Known gaps — do NOT raise these

These are already recorded. Reporting them costs everyone time.

| | Why |
|---|---|
| Baseline charts swing ±1.5σ daily on every machine | Known defect, **QFIX-BASELINE**, fix already written |
| Schematic widget shows `not_available` / `assets_unavailable` | No S3 bucket yet — Deepak's item |
| Only one equipment class exists (`demo-excavator`) | Library content not loaded yet |
| OEE shows only Availability | Performance and Quality are phase 2 (QOEE1) |
| Incidents is a view, not an object you can own or escalate | By design in phase 1 |
| No 3-D twin | QTWIN1, phase 2 |
| No data from the 1.0 system | `LEGACY_DB_*` not configured on Development |
| `parameter_list` and `forecast_chart` widgets missing | QREC0b.1, phase 2 |

---

## 8. Do

- **Test as the role.** Sign in as the operator to test operator screens, not as super admin.
- **Record the machine, the screen, the time and the exact URL** for anything you report.
- **Screenshot the whole window**, including the address bar.
- **Check `null` versus `0`.** If a number is missing, the screen must say *why*, not show zero.
- **Read the reason before calling a widget broken.** `not_configured` with a reason is the product working.
- **Report what you expected and what you saw**, in that order. Two lines is enough.
- **Re-test once after a deploy** before reporting — some things are fixed between your test and your ticket.
- **Use the six machines as designed.** They were built to show six different things.

## 9. Don't

- **Don't report a zero as "working".** A `0` where there is no data is the **most serious defect class on this platform.** Raise it immediately, above everything else.
- **Don't edit the database by hand** to make a screen look right.
- **Don't change seeded data expecting it to survive.** A re-seed wipes it.
- **Don't re-run the seeder yourself.** Ask — it resets the whole demo tenant.
- **Don't report anything in section 7, or anything listed as out of scope in section 2.**
- **Don't test on anything other than Development.** There is no Staging or Production yet.
- **Don't share credentials** in tickets, chat or screenshots.
- **Don't assume a blank widget is a bug** until you have checked its readiness and reason.
- **Don't batch up findings until the end of the day.** Report as you find them.

---

## 10. Reporting a defect

Five lines. Nothing more is needed.

```
Machine / screen:   EX-03, machine page
URL:                .../equipment/demo/EX-03
Time (IST):         2026-10-08 11:40
Expected:           open alert, high severity
Saw:                no alert; coolant widget showed 0
```

**Anything showing a number where there is no data goes to the top of the list**, whatever else is open.
