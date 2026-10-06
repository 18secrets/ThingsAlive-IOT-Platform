# QGRANT1 — the class content inventory, audited and held to what it claims

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/catalog-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/grant-inventory-audit`

**Stream B**, queued after QREC0a by the two-stream plan because it edits
`CLASS_CONTENT_INVENTORY`. No migration.

Drafted at the user's instruction. The plan named QGRANT1 but never defined it. The user
chose "inventory audit" over re-grant of a newer version, which stays QUPGRADE1's.

---

## 0. Why

QGRANT0 built `CLASS_CONTENT_INVENTORY` and a test that fails on any class-referencing table
the inventory does not list. Since then QREC0a, QREC0b, QPAGE1 and QCAT2 have added or changed
class content. Two gaps remain:

1. **The audit only sees two column names.** It looks for `class_slug` and
   `equipment_class_slug`. `plant.site_class_slug` (QREC0b) references a class and is in no
   entry — the exact silence the inventory exists to remove.
2. **`copy` is a claim nothing checks.** The test proves every table is listed; it never
   proves a `copy` table is copied. The inventory's own comments warn against "a copy no code
   performs". If `copy-on-grant.service.ts` stopped copying one, every test would stay green.

## 1. Each `copy` entry names where it lands

Add `copiedTo` to every `copy` entry, and to `is_the_class`. The tenant table a grant writes:

| source | copiedTo |
|---|---|
| `equipment_class_profile` | `client_equipment_class` |
| `scenario_definition` | `client_scenario` |
| `alert_rule_template` | `alert_rule` |
| `equipment_class_formula` | `client_formula` |
| `equipment_class_failure_mode` | `client_equipment_class_failure_mode` |
| `equipment_class_recommendation` | `client_equipment_class_recommendation` |
| `equipment_class_layout` | `client_equipment_class_layout` |

A `copy` entry without `copiedTo` fails a test, the same way an `exclude` without a reason does.

## 2. The audit sees every class reference

`findClassReferencingTables` matches any column ending in `class_slug`. A destination named in
some `copiedTo` counts as covered — it is where a copy goes, not a second source.

Expected new finding: `plant`, `exclude`, reason: the tenant's own site; `site_class_slug`
chooses which platform site class renders its page, the same relationship `equipment_profile`
has with an equipment class.

Report every table the widened audit names.

## 3. `copy` is proven, not claimed

A test driven by the inventory: publish a class through `CatalogAuthoringService` with at
least one row in every `copy` source, grant it with `CopyOnGrantService`, then assert every
`copiedTo` table holds a row for that tenant and no other. Iterate the inventory — do not
hard-code the list — so a new `copy` entry with no copy code fails naming its table.

## 4. Out of scope

- Upgrading a held copy to a newer version — QUPGRADE1.
- Copying site pages per tenant — `site_class_layout` stays `exclude`.
- Anything under `frontend/` or `src/catalog-import/`.

## 5. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after on a worktree
off `origin/main`, naming the base SHA. Existing tests unedited.
