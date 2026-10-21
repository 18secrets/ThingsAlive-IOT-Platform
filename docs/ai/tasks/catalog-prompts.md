# QGRANT0 — copy-on-grant carries everything the class owns

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/catalog-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b fix/copy-on-grant-completeness`

Rebase onto `feature/named-formulas` if it has not merged — this builds on the provenance
columns QCE3 added. Migration timestamp above `1758060000000` and above QCE3's.

---

## What was found

`copy-on-grant.service.ts` copies classes, scenarios and alert rules. **It has never copied
formulas** — not the named ones QCE3 added, not the hand-written ones that have existed since
QCE1.

A tenant granted a class receives a machine with no KPIs. The client machine page (D29, D30)
is built on exactly those formulas. We were four steps from granting a customer a class that
would have rendered empty, and nothing in the platform would have reported it.

Found by reading the file, not by a failing test. **That is the real defect** — the copy is a
hand-maintained list, so every table added since has been silently missing from it.

## 1. Copy the formulas

`equipment_class_formula` → the tenant's copy, carrying:

- the `compiled_plan` as data — **never a live reference** to a platform row
- `named_formula_slug`, `named_formula_version`, `bindings` as recorded provenance
- the KPI presentation metadata (D30) the class formula holds

A tenant must never resolve `named_formula` at runtime. Publishing `v2` of a named formula
changes nothing any tenant already holds. Same rule as the class version itself.

**Tests:** a granted class's tenant copy holds every formula the platform class holds, with
identical `compiled_plan`; the provenance fields survive; publishing a new named-formula
version leaves the tenant copy untouched.

## 2. The durable fix — make the omission impossible to repeat

A hand-maintained copy list will fall behind again. Replace the convention with a check.

**A declared inventory.** One module naming every table whose rows belong to an equipment
class, each marked exactly one of:

```ts
{ table: 'equipment_class_formula',  disposition: 'copy' }
{ table: 'equipment_class_profile',  disposition: 'is_the_class' }
{ table: 'catalog_import_batch',     disposition: 'exclude', reason: 'platform authoring provenance, not class content' }
```

**A test that fails on anything unlisted.** It reads the live schema for tables carrying a
class reference — `equipment_class_slug`, `class_slug`, or a foreign key to the class — and
fails naming any table absent from the inventory.

So the next person who adds a class-owned table gets a red test telling them to decide,
rather than a customer getting an empty page a year later. `exclude` is always allowed; a
**silent** omission is not.

**Tests:** the inventory covers every class-referencing table currently in the schema;
adding a table with a class reference and no inventory entry fails the test, with the table
named in the message.

## 3. Audit what else is missing

Run that test before writing the inventory and **report every table it names**. Formulas are
the one we know about. Report the rest; do not fix them in this branch unless the fix is the
same one line as formulas. Anything larger I will scope separately.

## 4. Re-grant is not re-copy

Determine and report what happens today when a class is granted to a tenant that already
holds a copy — does it duplicate, refuse, or silently skip? Then make it explicit:

- a grant where no copy exists → copies
- a grant where a copy of the **same class version** exists → no-op, reported as already held
- a grant of a **newer class version** → **refused** here, and named as QUPGRADE1's job

Do not build upgrade. State the boundary and refuse past it.

## 5. The stale `dist/` finding

`tsc` does not prune orphaned output; a compiled migration from another branch rode along in
the chain. Make `npm run build` clear `dist/` first, and add a CI assertion that the compiled
migration count equals the source count. One line each, and it closes a class of failure that
would otherwise surface as an unexplained production migration.

## 6. Out of scope

- Upgrading a tenant to a newer class version — QUPGRADE1.
- `equipment_class_visual` and page layout — QREC0, not built yet. List it in the inventory
  as `copy` with a comment that the table does not exist yet, or omit it and say so.
- Anything under `frontend/`.

## 7. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after.
- Full migration chain from empty; down path named with `undoMigrationNamed`.
- **Seed before you migrate** — the copy tests must run against a class that already holds
  formulas, not one created empty by the test.
- Report: commit SHA, test counts, **every table the §3 audit named**, what re-grant did
  before §4, and anything not implemented.

---

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

---

# QUPGRADE1 — upgrading a tenant's class copy to a newer version

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/catalog-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/class-upgrade`

**Phase 2.** Drafted at the user's instruction from the register entry, D39 ("The upgrade flow
is not currently anywhere and is a task of its own") and QREC0b/QREC0c, which built the layout
and anchor merges as pure functions "QUPGRADE1 calls later". Touches `src/client-catalog`.

---

## 0. Why

Copy-on-grant refuses a newer class version (QGRANT0 §4), so a tenant granted v1 never
receives v2: no new KPIs, no corrected failure mode, no new widget. Upgrading is not
re-copying — the tenant has edited their copy, and their edits are theirs.

## 1. Scope: content versioned with the class

The class row, `client_formula`, failure modes, recommendations, layout and anchors — every
copy whose template is pinned to `(class_slug, class_version)`.

**Not scenarios or alert rules.** They version on their own, not with the class, and already
have a per-item adopt path (`adoptScenarioTemplate`). Say so in the report.

## 2. Origin is computed, not stored

Each tenant row is classified against the template row **at the version it was copied from**
(its `template_version`), matched by key:

| type | key | compared fields |
|---|---|---|
| class | slug | name, description, category, default thresholds |
| formula | `formula_key` | expression, display and target fields, window, chart |
| failure mode | `code` | name, symptom, severity, signals |
| recommendation | failure mode + action | urgency, hours, parts |

- **inherited** — a template row exists and the content equals it;
- **customised** — a template row exists and the content differs;
- **tenant_added** — no template row at that version has the key.

A stored flag would need a backfill guess for every copy already in the field, and a wrong
guess means an upgrade silently overwrites a tenant's edit. Comparing against the immutable
published version cannot drift. A recommendation whose action text the tenant rewrote shows
as tenant-added, and the original as orphaned — honest, and nothing is lost.

## 3. What an upgrade does

| tenant row | in the new version | upgrade |
|---|---|---|
| inherited | changed or same | replaced by the new version's row |
| inherited | removed | kept, labelled **orphaned** (`orphaned_at`) |
| customised | changed | kept; the diff says upstream changed under it |
| customised | removed | kept, labelled orphaned |
| tenant_added | — | kept |
| absent | added | added |

Layout and anchors use `mergeTenantLayout` / `mergeTenantAnchors` unchanged — their rules
were decided in QREC0b/QREC0c. **Geometry:** there is no `geometry_version`; a different
schematic image (`asset_key`) between versions is the geometry change, and every
tenant-placed anchor is marked `needs_recheck`.

## 4. Endpoints

```
GET  /api/v1/my-catalog/equipment-classes/:slug/upgrade     the diff to the latest published version
POST /api/v1/my-catalog/equipment-classes/:slug/upgrade     { toVersion } — applies it
```

`client-catalog.read` / `client-catalog.write`. The POST names the version the tenant saw in the
diff; if a newer one has published since, it is refused rather than applying a diff nobody read.

**Idempotent, and locked.** Applying runs in the tenant session under an advisory lock on
(tenant, class) and re-reads the copy's version inside it. A second call for the same version
is a no-op that says so. A concurrent-call test proves both settle and the upgrade ran once.

## 5. Out of scope

- Scenarios and alert rules (§1). Copy-on-grant's refusal of a newer version stays.
- Tenant-added *signals* on the class row — the catalog picker is its own task.
- The diff UI — report the response shape.

## 6. Done when

`npm run build`, `npm run lint`, `npm test` and `npm run test:db` green, counts before and after
naming the base SHA. Migration above `main`; down path named with `undoMigrationNamed`.
