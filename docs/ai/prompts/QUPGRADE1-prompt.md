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
