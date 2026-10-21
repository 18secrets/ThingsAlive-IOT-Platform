# QREC0c — visuals, anchors and asset storage

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/library-content-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/class-visuals`

**Stream A.** Touches `src/catalog/**` and a new `src/assets/**`. Does not touch
`kpi-evaluator.service.ts`. Migration timestamp assigned immediately before opening the MR,
after the last merge-in — `main`'s newest is `1758300000000`.

**Dependency that is not code:** an S3-compatible bucket must exist. See §1. The task can be
built and tested without it; it cannot be deployed without it.

---

## 0. What this completes

QPAGE1 serves a `schematic` widget that returns `not_available` / `no_visual`, because
nothing supplies a visual. This supplies one.

**Tier 0 only — the schematic.** A labelled image with 2-D hotspots, one per signal. It works
for **every** equipment class on day one: no model, no 3-D authoring, no asset pipeline
beyond storing an image. The 3-D tier is QTWIN1 and it is a later, separate task.

The reasoning, so nobody reorders it: **what makes a twin worth looking at is a marker that is
green, amber or red with a reason.** That comes from readiness, which is built. The geometry
is the least valuable part.

## 1. Object storage — the decision, and what Deepak must provide

**S3-compatible, configured entirely by environment.** Do not hard-code a provider.

```
ASSET_S3_ENDPOINT        ASSET_S3_BUCKET
ASSET_S3_ACCESS_KEY_ID   ASSET_S3_SECRET_ACCESS_KEY
ASSET_S3_REGION          ASSET_S3_PUBLIC_BASE_URL   (optional, for a CDN in front)
```

**Dependency approved by name: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.**
Nothing else.

**With no configuration the module starts and logs that assets are unavailable** — the same
shape as `LegacyDataSource`'s warning. A missing bucket must not stop the API booting; it
makes visuals `not_available`, and nothing else.

**Assets never go in Postgres.** A 5–50 MB file in a row is a bandwidth bill and a backup
problem. The database stores a key; the bucket stores bytes.

**Report, do not assume:** whether Development has these variables set, and if not, say so —
provisioning the bucket is Deepak's and the task ships either way.

## 2. Schema

```sql
equipment_class_visual (
  id, class_slug, class_version,
  tier            text NOT NULL,   -- 'schematic' only, for now. CHECK it
  asset_key       text,            -- object key; NULL until uploaded
  content_type    text,
  width_px        integer,
  height_px       integer,
  uploaded_by, uploaded_at, created_at
)

equipment_class_visual_anchor (
  id, class_slug, class_version,
  signal          text NOT NULL,   -- must be declared by the class
  hotspot_x       numeric NOT NULL,  -- percentage, 0–100
  hotspot_y       numeric NOT NULL,
  label           text,
  created_at
)
```

One visual per `(class_slug, class_version)`. Unique on
`(class_slug, class_version, signal)` — one anchor per signal.

CHECK `hotspot_x` and `hotspot_y` between 0 and 100. A percentage is resolution-independent;
pixels are not, and the image will be replaced.

**Refused at publish, naming what:**

- an anchor whose `signal` the class does not declare — **never a silent fallback**. The demo
  did `anchorParts[key] || anchorParts.engine_runtime`, so a new signal landed on the wrong
  part of the machine and nobody was told. A coolant temperature drawn on the fuel tank is
  worse than no diagram.
- an anchor on a class with no visual row
- `tier` outside the CHECK

**A class with no visual publishes normally.** Tier 0 is a valid published state, or library
growth stalls behind image authoring. This is the same rule as QREC0b's layout fallback.

## 3. Upload and read

```
POST   /api/v1/platform/catalog/equipment-classes/:slug/:version/visual/upload-url
GET    /api/v1/platform/catalog/equipment-classes/:slug/:version/visual
DELETE /api/v1/platform/catalog/equipment-classes/:slug/:version/visual
PUT    /api/v1/platform/catalog/equipment-classes/:slug/:version/anchors
```

- **Upload is a presigned PUT.** The API never streams the bytes — it returns a short-lived
  URL and the key it will record. The console uploads directly to the bucket. An API that
  proxies 50 MB uploads is an API that falls over on the fourth one.
- The upload URL is refused for a **published** version. Visuals are class content and
  published content is immutable.
- **Allowed content types are a closed set**: `image/png`, `image/jpeg`, `image/webp`,
  `image/svg+xml`. Anything else refused, naming it.
- `PUT .../anchors` replaces the whole anchor set in one call, validated as a set. A partial
  anchor update is ambiguous — the same reasoning as QREC0b's reorder.
- Guarded by `catalog.write`; publishing stays `catalog.publish`.

**Reading** returns a signed GET URL with a short expiry, or the CDN URL when
`ASSET_S3_PUBLIC_BASE_URL` is set. **Never return the bucket credentials or a raw endpoint.**

## 4. Copy on grant, and tenant divergence

**The asset stays platform-owned and shared.** One file serves every tenant with that class —
that is what keeps bandwidth flat and the cache warm. A tenant never gets its own copy of the
image.

**The anchor set is copied on grant and becomes the tenant's.** It is rows, not megabytes,
and it is the part that diverges.

Add `client_equipment_class_visual_anchor` to `CLASS_CONTENT_INVENTORY` as `copy`.
`equipment_class_visual` is `exclude` — the tenant reads the platform row, with its reason
recorded, exactly as QREC0b did for `site_class`.

**A signal the tenant added themselves has no anchor.** It goes to an **unplaced tray** —
returned by the read endpoint as `unplacedSignals`, listed beside the visual, positioned later
by the tenant. **Never auto-assigned to a nearby anchor.**

**On a new class version:** class-origin anchors update; a tenant-placed anchor is preserved
and marked `placement_custom`. A marker somebody deliberately positioned is never moved
silently. Build the merge as a **pure function**, as QREC0b did — QUPGRADE1 calls it later.

## 5. The widget comes alive

QPAGE1's `schematic` widget stops returning `no_visual` and returns:

```ts
{ imageUrl, width, height,
  anchors: [{ signal, hotspotX, hotspotY, label, readiness, reason, value, unit }],
  unplacedSignals: [{ signal, readiness, reason }] }
```

**Anchors render per machine, not per class.** A machine without that sensor fitted shows the
anchor with its `unbound` readiness, or not at all — decided by the same readiness the rest of
the page uses, read from the same producer. **This task computes no readiness of its own**;
QPAGE1's rule still holds.

A class with no visual still returns `not_available` / `no_visual`. Unconfigured storage
returns `not_available` / `assets_unavailable` — a different reason, because they are
different problems.

## 6. Out of scope

- 3-D, GLB, three.js — **QTWIN1**.
- The site twin — per-customer content, a different owner and a different tool.
- The hotspot placement editor itself — frontend. **Report the endpoint shapes it needs.**
- Resizing, thumbnails, or any image processing. Store what is uploaded.
- Anything under `frontend/`.

## 7. Tests

1. An anchor naming an undeclared signal → refused at publish, naming the signal.
2. An anchor with no visual row → refused.
3. `hotspot_x` of 101 → refused by the CHECK.
4. A class with no visual publishes normally.
5. An upload URL for a published version → refused.
6. A content type outside the set → refused, naming it.
7. `PUT /anchors` replaces the set; a removed anchor is gone.
8. Copy-on-grant carries the anchors; the inventory test passes with the new entries.
9. A tenant signal with no anchor appears in `unplacedSignals`, **not** on a nearby anchor.
10. A new class version preserves a tenant-placed anchor and marks it `placement_custom`.
11. With no `ASSET_S3_*` configured, the module starts and the widget reads
    `not_available` / `assets_unavailable`.
12. The read endpoint returns a signed URL, never credentials or a raw endpoint.
13. RLS: a tenant cannot read another tenant's anchors.

**Seed before you migrate** — test 10 needs a tenant copy that existed beforehand.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA. **In-band, in chunks.**
- Migration timestamp assigned before the MR; `verify:migrations` clean; chain from empty;
  down path named.
- Report: commit SHA, test counts with base SHA, **whether Development has the `ASSET_S3_*`
  variables**, how you tested the S3 path without a bucket, the endpoint shapes the hotspot
  editor needs, and anything not implemented with the reason.
