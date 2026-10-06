# Phase 1 closeout — everything left before manual UI testing

For the Claude Code CLI. Work through this in order. Commit each prompt to
`docs/ai/prompts/` before starting its task.

**The goal of this phase is one thing: a person signs in to the console and exercises the
platform by hand.** Everything below either removes a defect that would mislead them, or
puts data in front of them. Nothing else belongs in this phase.

**Both streams' backend queues are complete.** What follows is four tasks and a merge.

---

## 0. First — the three open MRs

CI has been failing every job in under a second with empty logs. That is infrastructure, not
code. **Deepak is checking GitLab's compute minutes.**

Once CI runs again:

| MR | What | Note |
|---|---|---|
| **!72** | QFIX-DEVICES | auto-merge armed on `48114b3`, merges itself |
| **!73** | QUPGRADE1 | Stream B's, needs review — it carries a migration |
| **!74** | the `CLAUDE.md` baseline rule | docs only |

Report when all three are on `main`, and confirm the Railway deploy with
`railway logs --build --lines 50` then `railway logs --lines 100`.

---

## 1. QFIX-ROLES — skipped, and it is live-data correctness

**This was Builder B's first task and it never happened.** Its prompt is already in
`docs/ai/prompts/QFIX-ROLES-prompt.md`.

On `main` today, `alert-agent` is still in every pre-existing tenant role's `allowedTabs`
while `TENANT_ASSIGNABLE_PAGES` no longer contains it. **Every one of those roles fails to
save**, and only the console's own sanitising hides it. A person doing manual testing will
edit a role, and it will fail.

Do it exactly as the prompt says: a migration that strips any page not in the vocabulary,
plus the test that fails whenever stored data holds a page the vocabulary does not.

---

## 2. QFIX-FLAKY — the credentials race

`credentials.spec.ts` › *"gives the same answer for a wrong password and an address nobody
has"* fails intermittently in CI and passes locally.

Your diagnosis is almost certainly right: it starts two sign-ins concurrently and awaits them
one after the other, so the second rejecting first is reported as an unhandled rejection.

**Fix the race, not the assertion.** Await both together — `Promise.all` or
`Promise.allSettled` — and assert on both outcomes. The test's intent is unchanged, so this
is a fixture fix, not a behaviour change.

**Why it matters more than its size:** a flaky test teaches people to merge past red, and we
have already done that once this month. One unreliable test costs more than the bug it
guards.

---

## 3. QSEED1 — a demo tenant with data

**This is the task that makes manual testing possible.** Development has 17 classes and
**0 signal bindings, 0 devices, 0 projected equipment, 1 equipment profile**. `LEGACY_DB_*`
is not configured, so no telemetry arrives from 1.0 either. Without this, every screen shows
`not_configured` and the 48-case test plan proves nothing.

**One command, idempotent, guarded:**

```
npm run seed:demo
```

- **Refuses to run unless `SEED_DEMO_ENABLED=true`.** It writes a tenant's worth of data;
  it must be impossible to run against production by accident.
- Idempotent — running it twice leaves one demo tenant, not two.
- A matching `npm run seed:demo:reset` that removes only what it created.

**What it creates:**

| | |
|---|---|
| One tenant | `demo-construction`, with a super-admin user and the role templates |
| **One seed-only class** | authored by the seeder — see below. The published classes hold no sensor requirements, layouts, alert rule templates or baseline formulas, so seeding against them produces six identical `not_configured` machines |
| One site | a plant, with the default site class |
| Six machines | all on that one class |
| Devices and bindings | one device per machine, bound to every signal its class declares |
| Shifts | a weekday schedule, so Availability has scheduled hours to divide by |
| Telemetry | **90 days**, at each signal's declared cadence |

**The six machines must each demonstrate a different state**, because the states are the
product and a human has to see them side by side:

| Machine | Shows |
|---|---|
| 1 | healthy — everything `ready`, KPIs green, availability high |
| 2 | **trending** — a signal drifting toward its threshold over the last 10 days, not yet breaching |
| 3 | **breaching** — 6 of its last 10 readings past the bound, so M-of-N fires and an alert is open |
| 4 | **gone quiet** — bound, has 60 days of history, nothing for 3 days → `stale`, **not** `no_readings` |
| 5 | **newly commissioned** — 9 days of history → `baseline_not_established` on every baseline KPI |
| 6 | **partly unbound** — two signals the class declares have no binding → `not_configured` / `unbound` |

**Telemetry must look like telemetry.** A sine with noise and a slow drift, not a straight
line. A flat series makes `baseline_sd` zero, `zscore` divides by zero, and every baseline KPI
reads `undefined_result` — which would look like a bug and is not.

**Report what a tester should see** for each machine, as a short list, so the test plan can be
checked against it rather than against a guess.

**The seed-only class, and why it is allowed to exist:**

The seeder authors **one** complete equipment class — declared signals with criticality,
sensor requirements, a layout, alert rule templates, baseline formulas. All six machines use
it. Class variety is the library team's deliverable; **the six states are what manual testing
needs**, and one complete class demonstrates all six.

It is marked in the schema, not by naming convention:

- `equipment_class_profile.seed_only boolean NOT NULL DEFAULT false`
- **Granting a `seed_only` class is refused unless `SEED_DEMO_ENABLED=true`** — the same
  guard that protects the seeder, so it can never reach a real tenant
- `seed:demo:reset` removes it

**This does not paper over the content gap.** A class marked `seed_only` cannot be mistaken
for library content. **Report every published class's gaps** — missing sensor requirements,
layouts, alert rule templates, baseline formulas — as a list. That list is the library team's
work queue.

**`seed:demo` is the one demo seeder.** It replaces `seed-demo-fleet.ts` and absorbs what it
provided, so the six machines carry failure modes and recommendations and the recommendation
engine still has something to run against. **Before deleting it, check whether any test
depends on it** — if one does, move that content into a test fixture and cut the dependency.
A test depending on a demo seeder is a defect regardless of this task.

**Running it against Development** is granted as a one-time exception: `seed:demo` and its
reset, against Development Postgres, with `SEED_DEMO_ENABLED=true` passed inline for that one
command. **Do not persist it as a Railway variable.** Run after the MR merges and deploys,
not from the branch; run the reset first if a demo tenant already exists; report row counts
per table. Nothing else on Railway changes.

---

## 4. Incident Management — the view, not the entity

Phase 1 ships **a view over what already exists**, not a new object.

```
GET /api/v1/incidents?status=open
```

Returns, per machine with an open alert: the machine, its open alerts, any open work orders
against it, and the worst severity among them. **No new table, no new lifecycle, no SLA
clock.** Acknowledging and resolving stay on the alert; assigning and completing stay on the
work order.

An incident **entity** — ownership, escalation, SLA timers — is phase 2, and only once
someone has used alerts in anger and can say what is missing. Designing that workflow now
means designing against no evidence.

---

## 5. What is Deepak's, not yours

Do not attempt these; report if they block you.

| | |
|---|---|
| **GitLab compute minutes** — every CI job failing instantly | blocks all three MRs |
| **Protect `main`** — push: No one, merge: Developers + Maintainers | six days open |
| **The S3 bucket** — Cloudflare R2, four `ASSET_S3_*` variables | until then every schematic reads `assets_unavailable` |
| **QOPS1** — migrate `railway.json` **and** `railway.scheduler.json` | both stop working 2026-12-01, taking `preDeployCommand` and the CI gate with them |
| Library content loaded and verified | the library team, using the runbook |

---

## 6. Deferred to phase 2, deliberately

Recorded so nobody rediscovers them as gaps.

- **OEE** — Availability ships now, named Availability. Performance and Quality need OEM
  values authored per class, and the library has not yet loaded the content it already has.
  **Fully specified in `docs/ai/prompts/QOEE1-prompt.md`** — breakdown as an idle-with-fuel
  virtual sensor at a 30-minute class default, Quality as nominal ÷ actual fuel capped at
  100% with waste reported beside it, day/week/month from summed totals. **Do not start it
  during this phase.**
- **Incident entity** — see §4.
- **QTWIN1** — the 3-D twin. Tier 0, the schematic, is built.
- **QFIX-DEVICES-2** — prediction and baseline still read `device_projection`.
- **QONBOARD1** — bulk-registering a 1.0 fleet from the projection.
- **QTX1** — producers sharing one transaction. Forced by machine count on a site page, not
  by widget count: about 6 queries per machine today, fine at 20, not at 200.
- **QREC0b.1** — `parameter_list` and `forecast_chart` widgets.
- **Measurement role versus signal key** in coverage — unanswerable until Development has
  bindings. **QSEED1 gives it bindings, so measure it then and report.**

---

## 7. Order, and what to report

1. the three MRs, once CI is back
2. **QFIX-ROLES**
3. **QFIX-FLAKY**
4. **QSEED1** — the one that unblocks the humans
5. **Incident view**

Each as its own branch and MR, each with `test:db` before and after on a worktree off
`origin/main` naming the base SHA, the full suite on the branch only, migration timestamps
assigned immediately before the MR after the last merge-in.

**After QSEED1 lands and deploys, report the six machines and what each one should show.**
That is what the manual testing runs against.
