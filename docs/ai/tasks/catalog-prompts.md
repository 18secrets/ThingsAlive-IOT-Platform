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
