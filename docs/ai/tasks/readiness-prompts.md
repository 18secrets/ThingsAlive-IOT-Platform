# Q08S s3 — telemetry freshness per signal

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/readiness-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/signal-freshness`

Rebase onto `feature/calc-runtime` if QCE2 has not merged — QCE2 consumes what this
produces. Migration timestamp above everything on `main`.

---

## Why

Readiness already has four states and four reasons. Two of them, `stale` and `no_readings`,
are the difference between **"this machine has stopped reporting"** and **"this signal was
never wired"** — a maintenance call versus a commissioning task. Today there is no per-signal
notion of how old is too old, so they cannot be told apart reliably.

A coolant temperature reported every 30 seconds is stale after five minutes. An hour meter
reported once a shift is not stale after six hours. One global threshold is wrong for both.

QCE2 returns `stale` in its envelope and currently has nothing authoritative to ask.

## 1. The column

`equipment_class_sensor_requirement` gains:

```sql
stale_after_seconds integer NULL
```

Nullable, and **null means "use the platform default"** rather than "never stale". Record
the default as a named constant — **900 seconds** — with the reasoning beside it, not as a
literal in three places.

Do not add a workbook column. **Template v4 is QREC0's**, and it bumps once, not twice. The
mechanism ships now with the default; authors set it per signal when v4 lands.

Published class versions are immutable, so this column is set at authoring time and copied,
never edited in place.

## 2. Resolution order

For a bound signal on a machine, the effective threshold is the first of:

1. the tenant's class copy's `stale_after_seconds` for that requirement
2. the platform default (900 s)

**Not** the platform class's value — the tenant copy is the tenant's, per D04. If the copy
has null, the default applies; a later platform change does not reach them.

State in the report whether copy-on-grant already carries
`equipment_class_sensor_requirement`. QGRANT0's inventory listed it as a class-referencing
table, so it should — confirm rather than assume, and if the column is not copied, that is
part of this task.

## 3. The two reasons, told apart

For a signal on a machine, at evaluation time:

| condition | readiness | reason |
|---|---|---|
| no binding exists | `not_configured` | `unbound` |
| bound, but zero readings ever | `not_available` | `no_readings` |
| bound, readings exist, newest older than the threshold | `not_available` | `stale` |
| bound, newest within the threshold | `ready` | — |

**`no_readings` means never, not "none in this window."** A signal with readings last month
and none today is `stale`, not `no_readings`. Getting this backwards sends a commissioning
ticket for a machine that simply went quiet, and that distinction is the entire point of the
task.

Report where the current readiness computation lives and whether it already separates these.
If it conflates them, say which code path did.

## 4. Expose it

Wherever readiness is already returned — coverage, binding discovery, the machine's signal
list — the response gains, per signal:

```
{ staleAfterSeconds, lastReadingAt, secondsSinceLastReading }
```

`lastReadingAt` is null when there are none, which is what makes `no_readings` legible to a
UI without it having to infer anything.

## 5. Tests

1. A requirement with no `stale_after_seconds` resolves to 900.
2. An explicit value wins over the default.
3. Bound, never any reading → `no_readings`.
4. Bound, newest reading older than the threshold → `stale`, **not** `no_readings`.
5. Bound, newest reading inside the threshold → `ready`.
6. A signal exactly at the threshold boundary — state which way you resolved it and test it.
7. Two signals on one machine with different thresholds resolve independently, one `ready`
   and one `stale` in the same response.
8. The tenant copy's value is used, and a change to the platform class does **not** reach an
   already-granted tenant.
9. Copy-on-grant carries the column.

**Seed before you migrate** — test 8 needs a tenant copy that existed before the column did.

## 6. Out of scope

- The workbook column — QREC0, template v4.
- Alerting on staleness. A stale signal is a readiness state, not an alert. If someone wants
  to be told, that is an alert rule authored against it later.
- Anything under `frontend/`. Report the response shape.

## 7. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  on a throwaway commit or a second worktree — **not by stashing**.
- Full migration chain from empty; down path named with `undoMigrationNamed`.
- Report: commit SHA, test counts, where readiness is computed and whether it conflated the
  two reasons before, the boundary decision from test 6, whether copy-on-grant already
  carried the requirement table, and anything not implemented.

---

## Addendum (decided after implementation, 2026-10-02)

**Copy-on-grant confirmed correct as excluded** — `equipment_profile.class_version` already
pins which immutable platform row applies, which answers *which value applies*. It does not
answer *can the tenant change it* — those are different questions, and the architect's
correction is that the second one is a real, named gap rather than something copy-on-grant
should have solved.

**A tenant cannot override `stale_after_seconds` today, and that is a known limitation, not a
design.** A site with a flaky link legitimately needs a longer threshold than the platform
class declares, and the client owning their own configuration is a standing principle here
(D31). Its home is **QPARAM1**: `stale_after_seconds` is a parameter, client → site →
equipment, effective-dated, exactly the shape QPARAM1 exists for — not a second column on a
platform-owned, version-pinned table. Deferred there explicitly, not left implicit.

**`coverage()` must not reclassify on staleness — confirmed, not merely avoided.**
`coverage()` answers a configuration question (is this requirement bound); staleness is a
runtime condition. Merging them would flip a machine to "missing" because it sat switched off
over a weekend, sending someone to re-bind signals that were never unbound. Annotating every
requirement with `{staleAfterSeconds, lastReadingAt, secondsSinceLastReading}` is the right
shape: the caller shows "bound, quiet for 3 days" without the platform claiming it is
unconfigured.
