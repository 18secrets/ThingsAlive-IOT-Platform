# QSHIELD1 — ThingsShield evidence records

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Status: ready.** §7's questions were answered on 2026-10-12. The user accepted the
recommendation on each; the answers are written into §1–§3 and recorded in §7.

**Branch:** `feature/shield-evidence`, off `main`.

Drafted at the user's instruction after checking the ThingsShield and Incident Management
pages against the backend (2026-10-12). Incident Management is already served by
`GET /api/v1/incidents` (!78) and is not part of this task.

---

## 0. Why

The ThingsShield pages (`ThingsShieldPage`, `ThingsShieldDetailPage`) run entirely on
`frontend/src/data/shieldMockData.ts`, which says so itself: "no backend yet". Every
result, due date and owner on them is a sample. The page cannot be wired to anything until
a record of a real inspection exists somewhere.

This task builds the smallest honest version of that record: **one inspection or check,
against one machine, with what was found and when it is next due.** Nothing in it decides
what a site is legally required to do.

## 1. An evidence record

`shield_evidence_record`, tenant-owned, `tenant_isolation` forced like every other.

| column | |
|---|---|
| `id`, `tenant_id` | |
| `source_system`, `external_id` | the machine, keyed as `/incidents` and the machine page key it |
| `category` | `compliance` \| `safety` \| `security` — no `regulation` (§7 Q1) |
| `title` | free text, what was checked |
| `result` | `passed` \| `failed` \| `attention` |
| `performed_at` | when the check happened — not when it was typed in |
| `due_at` | when the next one is due; `NULL` for a one-off |
| `owner_user_id` | a 2.0 user in the same tenant, or `NULL` |
| `owner_name` | free text for an owner with no account (a contractor), or `NULL` |
| `reference` | the external reference: certificate, checklist or permit number |
| `findings` | free text |
| `recorded_by` | the user from the token, never from the body |
| `supersedes_id` | the record this one revises, or `NULL` |
| `created_at` | |

**A record is evidence, and evidence is immutable (G13).** A trigger refuses `UPDATE` and
`DELETE`. Correcting a record means writing a new one with `supersedes_id` pointing at it;
a unique index on `supersedes_id` makes a record revisable once, so two people correcting
the same record at once cannot both win. The current record is the one nothing supersedes.

`result` and `category` are CHECK constraints, not just DTO validation. So is "at least one of
`owner_user_id` and `owner_name`": a record nobody owns is a record nobody follows up.
`owner_user_id` is a foreign key to the user, so a user in another tenant cannot be named.

## 2. Status is derived, never stored

The mock's `Current / Due soon / Overdue / Action required` is computed at read time from
`result`, `due_at` and now:

- `action_required` — the current record's result is `failed` or `attention`
- `overdue` — `due_at` is in the past
- `due_soon` — `due_at` falls within the due-soon window: the parameter
  `shield.due_soon_days`, resolved through QPARAM1's four scopes like every other
  parameter, default **30** (§7 Q2). The response names the window it used.
- `current` — otherwise

Stored, it would be wrong the morning after it was written.

A machine with **no record** in a category reads `not_recorded` for that category — never
`current`. Missing evidence must not look like a pass (G04).

## 3. Endpoints

| | | capability |
|---|---|---|
| `GET /api/v1/shield/summary` | per machine in the caller's scope: per category, the current status and the record behind it; plus fleet counts per status | `shield.read` |
| `GET /api/v1/shield/equipment/:system/:id/records` | that machine's records, newest first, superseded ones included and marked | `shield.read` |
| `POST /api/v1/shield/equipment/:system/:id/records` | write a record | `shield.write` |
| `POST /api/v1/shield/records/:id/revisions` | write a record that supersedes `:id` | `shield.write` |

`shield.read` goes to every tenant role, `shield.write` to super admin and admin. Both are
appended to `src/auth/capabilities.ts` (§7 Q4). Any holder of `shield.write` may revise any
record in scope (§7 Q5).

Scope narrowing is the same machine set the incident view and work orders use — no new
scope rule. A machine outside the caller's scope is a 404, not a 403.

`POST .../revisions` is idempotent on `:id`: a second revision of an already-revised record
is a 409 naming the record that superseded it. It has a concurrent-call test
(`Promise.allSettled`, both settle, exactly one revision written).

## 4. Tests

`test/shield-evidence.spec.ts`:

- `UPDATE` and `DELETE` on a record are refused **by the database** — attempted as `ta_app`,
  not asserted from `pg_trigger`.
- A record from tenant A is invisible to tenant B through every endpoint, and RLS refuses it
  with the service bypassed.
- Each derived status, including `not_recorded`, and the boundary of the due-soon window.
- The concurrent-revision test above.
- `recorded_by` is the caller even when the body supplies another.
- A record with neither owner field, and one naming a user from another tenant, are refused
  by the database.
- `shield.due_soon_days` set at equipment scope changes that machine's status only.
- A viewer can read and is refused on both `POST` routes.
- Down path named with `undoMigrationNamed`.

## 5. Out of scope

- **Regulation applicability** — which requirements apply to a site, by jurisdiction. The
  mock marks it "To be confirmed"; it stays that way until someone with that knowledge
  supplies it.
- Attachments: certificates, photos (no S3 bucket).
- Reminders and notifications (no notification transport).
- Raising a work order from a failed record. Worth doing; it is a second task.
- An incident entity, and linking records to incidents.
- Any change under `frontend/`.

## 6. Done when

`npm run build` and `npm run test:db` green; `test:db` counts before and after, measured on a
worktree off `origin/main` naming the base SHA. Migration timestamp above `main`'s newest.
The OpenAPI tags and an example payload per endpoint for the UI team (G12).

## 7. Decisions (answered 2026-10-12)

The user accepted the recommendation on all five.

1. **`regulation` is not a category of record.** It is three categories for now. The
   mock's regulation row is the applicability register, which is out of scope (§5).
   `regulation` is added when it means a check someone actually performed.
2. **Due-soon window:** tenant parameter `shield.due_soon_days`, default 30. The default is
   ours, not a customer's policy, so it is a parameter from day one and every response names
   the window it used.
3. **Owner:** optional `owner_user_id` plus optional `owner_name`, at least one required,
   enforced by the database.
4. **Capabilities:** new `shield.read` (every tenant role) and `shield.write` (super admin,
   admin). The `things-shield` page entry already exists in `src/identity/pages.ts`.
   `src/auth/capabilities.ts` is a shared file: append only.
5. **Revision:** any holder of `shield.write` may revise any record in scope. Nothing is
   lost by this, because the original stays and `recorded_by` names who revised it. Narrow
   this to the author and admins only if real use shows it is needed.

## Recorded at implementation (2026-10-12)

- The parameter is `shield_due_soon_days`, not `shield.due_soon_days`: every operational
  parameter name is snake_case, and the database's value check now gives it the same
  positive-whole-number arm as `stale_after_seconds`.
- **Standing record per category:** the latest check by `performed_at` among records
  nothing has corrected. An older check followed by a newer one is history, not a second
  status. A machine with two different checks in one category (a guard inspection and an
  extinguisher check, both `safety`) shows only the latest. If that turns out wrong in use,
  the fix is a check type, not a different rule here.
- Status precedence: `action_required` > `overdue` > `due_soon` > `current`. The due-soon
  edge is inclusive.
- The revision key carries tenant, machine and category, so a revision cannot move any of
  them — refused by a composite foreign key, not by the service.
- `ta_app` holds SELECT and INSERT only. With no UPDATE grant it cannot `SELECT ... FOR
  UPDATE`, so the unique `(tenant_id, supersedes_id)` index decides a revision race.
- `src/identity/role-templates.ts` changed as well: ceo-manager and site-manager get both
  capabilities, operator gets `shield.read`. The migration grants the same to existing
  roles still exactly at the template default, compared as a set. `allowedTabs` is
  untouched — whether a role sees the ThingsShield tab stays the client's choice.
- A profile with evidence cannot be deleted (no cascade); evidence outlives a profile.
