# QFIX-DEVICES — the binding is the authority

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/readiness-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b fix/device-authority`

**Stream A.** Unblocked now that QPARAM1 has merged — this touches
`kpi-evaluator.service.ts`, which was Stream B's until then. Migration timestamp assigned
immediately before the MR, after the last merge-in.

---

## 0. The defect, as you found it

Two producers disagree about which device is on a machine:

| Producer | Reads | Its answer means |
|---|---|---|
| KPI evaluator, prediction, baseline, `signal_chart` | `device_projection` | where **1.0** thinks the device is |
| `SignalBindingService.coverage` → `readiness_list`, `machine_list` | `device_inventory` | where **the customer claimed** it |

They are independent writers. Neither is a projection of the other — my earlier guess was
wrong. So a machine can show **KPIs ready beside signals reporting `no_readings`**, in two
adjacent widgets of the same page.

**`signal_binding_version` already holds the precise answer** — an IMEI per signal with a
validity window — and **both producers already depend on it**. The evaluator refuses a KPI
unless a binding resolves, then reads telemetry by projection IMEIs. Coverage counts
bindings, then checks freshness by inventory IMEIs. Each one asks the right question and then
reads the wrong table.

**So the fix deletes two reads. It adds no sync and no column.**

## 1. The rule

> **For "which device produced this signal on this machine, and when", the active
> `signal_binding_version` is the authority.**

Nothing else. The two device tables keep their own, different jobs:

- **`device_projection`** stays the upstream mirror the legacy telemetry pull needs — that
  pull is by projection IMEI and stays that way, because it is asking 1.0 a question about
  1.0.
- **`device_inventory`** stays the commercial and physical lifecycle, and the starting point
  for binding discovery.

## 2. The two reads to change

**a. The evaluator reads telemetry by the binding's IMEI.** `resolveBinding` already returns
it. Use that, not the projection's.

**b. Coverage checks freshness by the binding's IMEI.** Same source.

**Report every call site you changed and every one you deliberately did not**, with the
reason. Prediction, baseline and recommendation also read the projection; say whether they
are on this path or a different question.

**This fixes case 4, which neither device table can:** a device moved between machines. Only
the binding's validity window knows when, so only a binding-sourced read attributes history to
the machine that actually had the device at that time. Test it.

## 3. The CHECK on `device_inventory.state`

`state` has no constraint. An invalid `'claimed'` went in unrefused during QPAGE1 and only
surfaced when it was corrected to a valid value. A column with a vocabulary and no constraint
eventually holds something nothing can read.

Add the CHECK, from the vocabulary `InventoryService` already uses — **read it, do not retype
it from memory.**

**Timing is the argument:** `device_inventory` has **zero rows** in Development today. Adding
a CHECK to an empty table is free. After a customer's fleet is in there it means reconciling
whatever got in meanwhile.

**Report the vocabulary you found**, and whether any code writes a value outside it.

## 4. Tests

1. A machine whose binding IMEI differs from its projection IMEI → the KPI reads telemetry
   from the **binding's** device.
2. The same machine → coverage reads freshness from the **binding's** device.
3. **The page no longer contradicts itself**: on a machine present in one device table only,
   `kpi_number` and `readiness_list` agree. Write this one deliberately — it is the defect.
4. **Case 4:** a device bound to machine A until T, then to machine B. A window spanning T
   attributes each part to the machine that held it. Neither device table can produce this
   answer; assert it.
5. No binding at all → `not_configured` / `unbound`, unchanged.
6. A binding whose window has closed and no replacement → `not_configured` / `unbound`, not
   a read from a stale device.
7. `device_inventory.state` outside the vocabulary → refused by the CHECK.
8. The legacy telemetry pull still reads by projection IMEI — **assert it did not change.**

**Seed before you migrate.**

## 5. Out of scope

- **QONBOARD1** — bulk-registering a 1.0 fleet from the projection so legacy devices get
  inventory rows and can be discovered. Separate task, before the first migrated customer.
- Changing binding discovery's source. It stays inventory-sourced; the legacy gap is
  QONBOARD1's.
- Any new column, any sync between the device tables. If you find yourself adding one, the
  diagnosis was wrong — stop and say so.
- Anything under `frontend/`.

## 6. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Migration timestamp assigned before the MR; `verify:migrations` clean; chain from empty;
  down path named.
- Report: commit SHA, test counts with base SHA, **every call site changed and every one
  deliberately not**, the `state` vocabulary you found and whether anything writes outside it,
  and anything not implemented with the reason.

**One line for the task doc, because it is the lesson and not the fix:** two services each
asked the right question and then read the wrong table, and nothing failed — the page simply
disagreed with itself. The test that catches that class of defect is one that reads **two
widgets of the same page and asserts they agree**, not one that tests either producer alone.
