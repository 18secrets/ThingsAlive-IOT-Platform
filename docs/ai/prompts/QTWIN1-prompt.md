**Status: draft for Deepak's review** — drafted 2026-10-20 from the recorded decisions; nothing here is decided that a decision file does not already decide.

# QTWIN1 — the 3-D twin, backend: the model tier, 3-D anchors, the tray

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/qtwin1`

**Depends on:** QPAGE1 (the composed page), QREC0c (class visuals, anchors, asset storage),
QUPGRADE1 (the upgrade flow and `needs_recheck`). All merged. The bucket is **not** a
dependency of the build: storage is behind `AssetStorage`, faked in tests, and an
unconfigured bucket already reads `assets_unavailable` (QREC0c §1).

Decisions this task implements and must not re-derive: **D38** (the twin is tiered; the
`model` tier is a GLB per class shared by every tenant, with 3-D anchors placed with the
editor; anchors are keyed by asset, not by class; markers render per machine from
readiness), **D39** (the asset is platform-owned and immutable, the anchor set is copied on
grant and then tenant-owned; a new signal goes to an unplaced tray, never onto a guess;
the asset carries a `geometry_version`, and when it changes, customised anchors are
marked `needs_recheck` and shown in the tray rather than on the model until someone
confirms them).

---

## 0. Why

D38 put the 3-D tier after QPAGE1 so it would be built once, as a widget. QPAGE1 and
QREC0c shipped tier 0 — the schematic, 2-D hotspots, the editor's data, the tray — and
QUPGRADE1 shipped the upgrade flow with `needs_recheck`. The 3-D tier is the part D38 and
D39 describe in most detail and the part nothing has built.

The WebGL widget and the anchor editor are the UI team's (UI-12). **This task builds the
API they read and write. Nothing under `frontend/`.**

### 0.1 What exists, and what does not, verified on `main` (`6135d46`)

Built by QREC0c, QPAGE1 and QUPGRADE1 — **reuse, do not rebuild**:

- `equipment_class_visual` (one per class version) and `equipment_class_visual_anchor`
  (`hotspot_x`, `hotspot_y` as percentages); presigned PUT, confirm-after-HEAD, signed or
  CDN GET (`src/assets/asset-storage.ts`, `class-visual.service.ts`).
- `client_equipment_class_visual_anchor`: copied on grant, `placement_custom`,
  `needs_recheck`, RLS. Tenant read and whole-set replace (`client-visual.service.ts`).
- The `schematic` page widget, rendering per machine with readiness and the newest value,
  and the unplaced list (`page.service.ts`).
- The upgrade merge (`mergeTenantAnchors`) and `needs_recheck` when the schematic's
  `asset_key` changes between versions.
- The class-content inventory: `equipment_class_visual_anchor` is `copy`,
  `equipment_class_visual` is `exclude`.

Absent:

- **No 3-D tier.** `ck_class_visual_tier` admits only `'schematic'`, and its own comment
  says "The 3-D tier is QTWIN1 and adds its value here". One visual per class version
  (`uq_class_visual`), so a class cannot hold a schematic *and* a model.
- **No 3-D position.** Anchors are 2-D percentages only.
- **No `geometry_version`.** QUPGRADE1 used "a different `asset_key`" as the geometry
  change, because the column did not exist.
- **No `twin_3d` widget type**, and no producer for one.
- **The schematic does not move `needs_recheck` anchors to the tray** — it draws them where
  they were. D39 states the rule for 3-D anchors; this task applies it there. The schematic
  is question 6.

## 1. Schema — one table family, keyed by asset tier

D38: *anchors are keyed by asset, not by class* — `visual_asset(…, geometry_version, ref)`,
`visual_anchor(asset_id, signal, x, y, z?)`. The existing tables become that, by adding a
tier to the key rather than adding parallel tables:

- `equipment_class_visual`: tier `'schematic' | 'model'`; unique per
  `(class_slug, class_version, tier)`. A model row carries `geometry_version` and its
  bounding box (`bounds_min_x/y/z`, `bounds_max_x/y/z`, model units) once confirmed; a
  schematic row carries neither. Content type `model/gltf-binary` for a model, the four
  image types for a schematic — a CHECK per tier.
- `equipment_class_visual_anchor` and `client_equipment_class_visual_anchor`: a `tier`
  column (default `'schematic'`, so every existing row and path is unchanged), and
  `pos_x/pos_y/pos_z`. A schematic anchor has hotspots and no position; a model anchor a
  position and no hotspots — a CHECK. Uniqueness and the anchor → visual foreign key gain
  the tier.
- **A model anchor lies inside its model's bounds**, enforced by trigger on both tables:
  the platform anchor against its own version's model; the tenant anchor against the
  model of the version it was written for (`template_version`). An anchor on a model whose
  upload is not confirmed is refused. A tenant anchor marked `needs_recheck` is exempt —
  it is in the tray precisely because it may not fit the geometry any more.
- `twin_3d` added to the three layout `widget_type` CHECKs.

Parallel tables were the alternative. They would add a class-referencing table the
inventory must classify and a second copy path doing the same thing — the drift QGRANT0
exists to stop.

### 1.1 geometry_version

An integer, per class slug, on the model row. Assigned at confirm:

- the first model for the slug → 1;
- a new upload whose bounding box differs, or whose uploader says the geometry changed →
  one more than any `geometry_version` the slug has used;
- a re-upload declared geometry-unchanged with identical bounds (re-textured, recompressed)
  → kept.

A fork carries its version's model row unchanged, so `geometry_version` follows the
bytes, not the class version. **Bounds changing forces a new geometry version**: a box
that moved means markers placed against the old one may not fit.

## 2. Platform authoring (`catalog.write`, a draft only, as the schematic)

```
POST   /platform/catalog/equipment-classes/:slug/:version/model/upload-url   { contentType }
POST   /platform/catalog/equipment-classes/:slug/:version/model/confirm      { boundsMin, boundsMax, geometryChanged? }
GET    /platform/catalog/equipment-classes/:slug/:version/model
DELETE /platform/catalog/equipment-classes/:slug/:version/model
PUT    /platform/catalog/equipment-classes/:slug/:version/model/anchors      { anchors: [{ signal, x, y, z, label? }] }
```

The schematic's routes and rules, applied to a GLB: the API never sees the bytes; the
console measures the bounding box as it measures an image's width and height; confirm
HEADs the object for existence, type and size. Anchors are a whole set, validated as a
set, serialised on the model row. **Publish** refuses an anchor naming an undeclared
signal, an anchor outside the bounds, and an upload issued but never confirmed — the same
net as the schematic's. **Publishing is not gated on having a model** (D39).

## 3. Grant, tenant, upgrade

- **Grant** copies the model anchors with the schematic ones; the GLB is not copied.
- **Tenant** (`client-catalog.read` / `.write`):

  ```
  GET  /my-catalog/equipment-classes/:slug/model
  PUT  /my-catalog/equipment-classes/:slug/model/anchors              { anchors: [...] }
  POST /my-catalog/equipment-classes/:slug/model/anchors/:signal/confirm
  ```

  The PUT replaces the whole set; a moved or added anchor becomes `placement_custom` and
  loses `needs_recheck` (it was just positioned against this geometry); an unchanged one
  keeps both flags. Confirm keeps the position and clears `needs_recheck` — *"I looked; it
  is still right"* — and is **idempotent**. Both take the tenant's class row lock, so two
  editors cannot interleave a delete-and-insert.
- **Upgrade** (QUPGRADE1's flow, extended): the model anchors merge by the same rule as
  the schematic ones. A geometry change is a different `geometry_version` between the two
  versions' models — or a model present on one side only. On a geometry change, every
  tenant-placed model anchor is marked `needs_recheck`. The preview reports
  `modelAnchors: { added, removed, keptCustom, needsRecheck }` beside `anchors`.

## 4. The page — `twin_3d`

A widget type (`binds: 'none'`, equipment pages). Producer: the class model + the
tenant's model anchors; readiness via coverage; values via the bucketed read the
schematic already uses — **one read for both**.

```
{
  modelUrl, contentType, geometryVersion, bounds: { min: [x,y,z], max: [x,y,z] },
  anchors: [{ signal, x, y, z, label, readiness, reason, value, unit }],
  unplacedSignals: [{ signal, readiness, reason, needsRecheck }]
}
```

- The tray holds every declared signal with no model anchor **and every anchor marked
  `needs_recheck`** — with `needsRecheck: true`, so the editor can say *"check this
  marker"* rather than *"place this signal"*.
- Unfilled states, reused from the schematic so a reader handles both alike:
  `no_model`, `upload_pending`, `assets_unavailable`. `no_model` is what tells the UI to
  fall back to the schematic or the list (D38: the tiers are fallbacks).
- A machine without a sensor still shows its marker with its unbound readiness —
  QREC0c's reasoning, unchanged.

## 5. Out of scope

- The WebGL widget, the anchor editor, any rendering (UI-12). Anything under `frontend/`.
- The **variant** tier and the **site twin** (D38): a different asset per make/model, priced
  as an exception; its own task.
- Mesh processing of any kind: validation of GLB contents, decimation, thumbnails.
- Cleaning up unreferenced objects (the schematic's rule: a published version or a fork
  may share the bytes).
- Template-sheet columns for 3-D anchors. Placement is the editor's job; an author typing
  coordinates into Excel is not a workflow anyone asked for (question 4).

## 6. Tests

New spec `test/twin-model.spec.ts`, added to `test:db`. Storage faked exactly as
`test/class-visuals.spec.ts` fakes it (real presigning, faked HEAD).

**Refused, by attempting**
1. A model anchor outside the bounds: by the trigger (raw insert), by the PUT, at the boundary.
2. A model anchor on an unconfirmed model: by the trigger.
3. A schematic-tier anchor with a position, a model-tier anchor with hotspots: the CHECK.
4. A GLB content type on a schematic row, an image on a model row: the CHECK.
5. A model anchor on an undeclared signal: at the PUT and at publish.
6. Publish with a model upload never confirmed.

**Geometry**
7. First confirm → `geometry_version` 1; re-upload declared unchanged with the same bounds →
   kept; different bounds → bumped even when declared unchanged.
8. A fork carries the model row and its `geometry_version`, and the anchors.

**Grant, tenant, tray**
9. Grant copies the model anchors (tier `model`) beside the schematic ones; the GLB is not
   copied; the inventory audit is unchanged and passes.
10. A tenant-added signal is in the tray, never on a nearby anchor.
11. Moved and added anchors become custom; unchanged ones keep their flags.
12. Tenant B cannot read tenant A's model anchors — directly, and over HTTP.
13. A tenant anchor outside the bounds is refused by the trigger; the same anchor marked
    `needs_recheck` is accepted.

**Upgrade**
14. A new version with a different `geometry_version`: tenant-placed model anchors are
    `needs_recheck`, kept in place, and appear in the tray, not on the model; class-origin
    anchors take the new positions.
15. Same `geometry_version`: nothing is marked.
16. Confirm clears the flag and the anchor returns to the model.

**Concurrency**
17. Two confirms of the same anchor together (`Promise.allSettled`): both fulfilled, flag
    cleared, one row.
18. Two whole-set PUTs together: both fulfilled, the stored set is exactly one of them.

**Page**
19. `twin_3d` renders per machine: signed URL, geometry version, markers with readiness,
    tray with `needsRecheck`.
20. Each unfilled state: `no_model`, `upload_pending`, `assets_unavailable`.

**Migration**
21. Down path named by its own migration: the CHECKs, columns and triggers are gone and
    the schematic still works; then up again.

## 7. Done when

- `npm run build`, `npm run lint`, `npm test` and `npm run test:db` green. Counts before and
  after on a worktree off `origin/main`, naming the base SHA; the delta is this spec's count.
- No existing test edited. The schematic's behaviour is unchanged; its spec proves it.
- Report: what was built, the response shapes for UI-12, every assumption.

**One line for the task doc:** the 3-D twin is the schematic with a third coordinate and a
geometry that can change under a marker — so the work is the tier in the key, the bounds
in the database, and the tray that catches a marker the geometry moved under.

---

## 8. Questions — answer before starting

1. **One table family or parallel tables?** *Recommendation:* one, with the tier in the key
   (§1). D38's own model keys anchors by asset; parallel tables would be a second inventory
   entry and a second copy path doing the same thing.
2. **Bounds in the database?** The schematic's anchors are percentages, so 0–100 is a CHECK.
   A model's coordinates are model units, so "on the model" needs the model's box.
   *Recommendation:* yes, the console reports the box at confirm (as it reports an image's
   width and height), and a trigger refuses an anchor outside it. A marker floating beside
   the machine is the 3-D form of the coolant reading drawn on the fuel tank.
3. **What counts as a geometry change?** *Recommendation:* §1.1 — the uploader says so, or the
   bounds differ. Comparing bytes would mark every anchor for recheck on a texture fix,
   which teaches people to click "confirm" without looking.
4. **Template sheet columns for 3-D anchors?** *Recommendation:* no. Placement is done in
   the editor; coordinates typed into a spreadsheet are guesses.
5. **Model size bound.** The schematic's confirm accepts up to 50 MB. *Recommendation:* the
   same bound for a GLB for now. A class mesh above it is a content problem to solve before
   upload, not a limit to raise.
6. **Should the schematic also move `needs_recheck` anchors to its tray?** D39 states the
   rule for 3-D anchors; QREC0c's schematic draws them where they were. *Recommendation:*
   yes, but as its own small change to the schematic widget with its own test, not inside
   this task — this task must leave the schematic's behaviour exactly as its spec pins it.
7. **Delivery.** D38: *one model per class shared across tenants is what makes delivery
   cacheable.* A signed URL changes every request and defeats the cache. *Recommendation:*
   nothing to build — `ASSET_S3_PUBLIC_BASE_URL` (a CDN in front of the bucket) already
   returns a stable URL. Record that the model tier wants it set before real meshes ship.
