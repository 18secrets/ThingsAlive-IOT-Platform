# Identity tasks

Task prompts for identity, roles and access, appended as each task starts.

---

# QFIX-ROLES — strip `alert-agent` from stored tenant roles

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/identity-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b fix/stale-role-pages`

**Stream B, and do it before QPARAM1.** It is small and it is live data correctness.
Migration timestamp assigned **at rebase time**.

---

## 0. What happened

| | |
|---|---|
| `1757951000000-BackfillTenantRoleAllowedTabs` | wrote `alert-agent` into `allowedTabs` for **ceo-manager, site-manager and operator, in every tenant** |
| MR !53, merged 2026-10-05 | removed `alert-agent` from `TENANT_ASSIGNABLE_PAGES` |
| `role.service.ts:190` | `validateAllowedTabs` throws `BadRequestException` on any unknown page |
| — | **no migration cleaned the stored values** |

So every role created before today fails to save with *"Unknown page: alert-agent"* the
moment anyone edits it. Reading works. Editing does not.

**The console hides it.** `RoleManagement.tsx` strips stale grants before saving, on purpose
and with a comment saying so. So the UI path works and nobody notices, while
`PATCH /identity/roles/:slug` from anywhere else returns 400.

That is the shape to avoid: invalid data, one caller that sanitises it, another that fails.
**The fix belongs in the data.**

## 1. The migration

Strip any page not in `TENANT_ASSIGNABLE_PAGES` from every stored `allowedTabs`.

- Written against the **current** vocabulary, not a hard-coded `'alert-agent'`. If another
  page is retired later, this migration having been general does not help then — but
  hard-coding one string invites the next person to copy it. Read the constant.
- Report **how many rows changed and in how many tenants**. If the answer is zero, say so
  loudly — it would mean the backfill never ran where we think it did.
- **Idempotent.** Running it twice changes nothing the second time.
- The **down path** does not restore `alert-agent`. Restoring a value the application now
  refuses is not a reversal, it is reintroducing the defect. Say that in the migration's
  comment so the empty down is clearly deliberate rather than forgotten.

**Seed before you migrate.** The test seeds roles holding `alert-agent` across two tenants,
runs the migration, and asserts both are clean and that valid pages beside it survived.

## 2. Close the gap that let it happen

A page can be removed from the vocabulary again. Make the next removal safe:

**A test that fails when stored data holds a page the vocabulary does not.** It reads
`tenant_role.allowedTabs` across all tenants and asserts every value is in
`TENANT_ASSIGNABLE_PAGES`. Same pattern as QGRANT0's inventory test: the build reports the
drift instead of a customer finding it.

In the DB-gated suite, seeded, so it runs against known rows rather than whatever Development
happens to hold.

## 3. Do not

- **Do not change `src/identity/pages.ts` or `role-templates.ts`.** Both are as intended;
  CEO/Manager receiving every assignable page is accepted.
- **Do not make `validateAllowedTabs` lenient.** Silently dropping an unknown page on save is
  how a role quietly loses access nobody asked it to lose. The refusal is correct; the data
  was wrong.
- Do not touch `frontend/`. Its sanitising stays — it is harmless once the data is clean.

## 4. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  **worktree off `origin/main`**, naming the base SHA.
- Migration timestamp assigned **at rebase**; `verify:migrations` clean; chain from empty.
- Report: commit SHA, test counts with base SHA, **how many rows and tenants the migration
  changed in Development**, and anything not implemented.

---

## Recorded at implementation (2026-10-06)

Development before the migration (read-only count): **36 of 39 roles, in 12 of 13 tenants, hold a
page outside the vocabulary — every one of them `alert-agent`, and nothing else.** The backfill ran
where we thought it did; the count is not zero. The migration prints its own count to the deploy log
(`StripRetiredRolePages: N role(s) changed in M tenant(s).`) so the number that actually changed is
on record, not inferred.

Stream B's task by origin; done by Stream A under the phase 1 closeout, which reassigned it.
