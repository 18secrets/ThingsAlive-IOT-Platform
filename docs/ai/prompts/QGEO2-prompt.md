# QGEO2 — geofence zones, entry/exit events, operators

Read `CLAUDE.md` first. Builds on QGEO1 (`QGEO1-prompt.md`): `plant.boundary`,
`site_boundary_problem`, `src/catalog/formula/geofence.ts`, `outside_site`.

Drafted at the user's instruction, 29 October 2026. The user chose: restricted no-go zones,
entry/exit events, route corridors and time-in-zone reporting; polygons and circles; delivery
as staged merge requests, each green and mergeable on its own. No PostGIS (QGEO1's decision:
Railway's Postgres has none), no npm dependency.

---

## 0. Why

QGEO1 answers one question: is a machine inside its site? Customers also need places a
machine must not go, paths it must keep to, a record of when it came and went, and how long
it spent where. Geofencing becomes its own module, `src/geofence`, so alerts, work orders,
the assistant and workflows can use it later without it knowing about any of them.

## Stage 1 — zones, geometry, API (this branch)

### A zone

`geofence_zone`, tenant-owned, RLS `tenant_isolation`:

| column | meaning |
|---|---|
| `code`, `name` | `code` unique in the account, letters/digits/`.-_` |
| `kind` | `allowed` (should stay inside), `restricted` (must not enter), `corridor` (should stay on the path) |
| `shape` | `Polygon` (GeoJSON, as `plant.boundary`), `Circle` `{center: [lng, lat], radiusM}`, `Corridor` `{path: [[lng, lat], …], widthM}` |
| `applies_to` | `account`, `plant`, `equipment`, `equipment-class` — the same four alert rules use |
| `enabled` | a switched-off zone is kept, and applies to nothing |

The database refuses: a malformed shape (`geofence_shape_problem`, which reuses
`site_boundary_problem` for polygons); a corridor kind without a corridor shape, or a corridor
shape on another kind; a target that does not match `applies_to`; a target in another account
(composite foreign keys including `tenant_id`); a duplicate code.

Limits: a circle's radius is above 0 and at most 50 km; a corridor's width above 0 and at
most 5 km, with at least two path positions. Site scale, like QGEO1 — larger is a region,
not a fence.

`code` and the target are fixed once created: moving a zone to another machine is a new
zone, so stage 2's events never refer to a zone that meant something else when they fired.
A zone's target being deleted deletes the zone; it applied to nothing else.

### Geometry — `src/geofence/geometry.ts`

Pure functions. Polygons use QGEO1's `insideBoundary` unchanged. A circle is a haversine
distance to its centre. A corridor is inside when the distance to the nearest path segment is
at most half its width (segment distance on a local equirectangular projection — accurate at
corridor scale). On an edge counts as inside, as QGEO1 decided.

`violates(kind, inside)`: `allowed` and `corridor` when outside, `restricted` when inside.

### API

| route | capability |
|---|---|
| `GET /geofences`, `GET /geofences/:id` | `catalog.read` |
| `POST /geofences`, `PATCH /geofences/:id`, `DELETE /geofences/:id` | `equipment.write` (as the site boundary) |
| `GET /equipment/:sourceSystem/:externalId/geofences` — every zone that applies to the machine, its site boundary included as an `allowed` zone | `catalog.read` |
| `POST /equipment/:sourceSystem/:externalId/geofences/check` `{lng, lat}` — inside and violation per zone | `catalog.read` |

A person narrowed to sites or machines does not see, or target, a zone on a site or machine
outside their scope; account and machine-type zones are visible to all.

## Stage 2 — entry/exit visits

`geofence_visit`: one row per stretch of time a machine spent inside a zone, its site boundary
included (`zone_key` is `zone:<id>` or `site:<plant id>`). The database holds at most one open
visit per machine and zone (partial unique index), an exit as time, place and reason together,
and exit after entry. Deleting a zone keeps its visits (`zone_id` SET NULL, snapshot columns).

**When.** In the shift pass (D12), from the readings it already holds, on the scored path and
the engine-never-ran path — a machine with its engine off can still be moved. Never fatal, as
alert evaluation is not. `ShiftRunner` takes the tracker as an optional last argument, so the
runners existing tests build by hand are unchanged.

**Positions.** `latitude` and `longitude` paired per logger with QGEO1's `pairPositions`, the
window as the runner pulls it: after the start, up to the end.

**Recomputing.** A late reading rewinds the shift and every later one (`rewindForLateArrivals`).
A pass reconciles rather than appends, so the same window twice writes nothing the second time.
A window decides only what is timestamped inside it: a leave after its end is a later
window's, and is kept. Concurrent passes over one machine serialise on an advisory lock.

**Events** (`domain_event`, D11), subject `<source>/<external id>/<zone key>`:
`geofence.entered.v1`, `geofence.left.v1` (with `violation` and `dwellSeconds`),
`geofence.visit.revised.v1` (a leave time moved) and `geofence.visit.withdrawn.v1` (a late reading
showed a visit never happened). `violation` is true on entering a restricted zone and on leaving
an allowed zone or a corridor.

**A zone switched off or removed** closes the visits inside it at the next window's start, as
`zone_removed`, with no exit position: the machine did not move, the fence did.

**API.** `GET /equipment/:sourceSystem/:externalId/geofence-visits` and
`GET /geofences/:id/visits`, `catalog.read`, newest first, at most 500, `from`/`to` on entry time.
A site-boundary visit is hidden from someone who cannot see the site.

**Not here:** replay (G10) of visits — the alert replay harness does not call the tracker, so a
replay cannot write visits or events. Acting on events (an alert per restricted entry) is a
consumer's, in stage 3 or later.

## Stage 3 — operators and the assistant (after)

`outside_zone(latitude, longitude, 'code')`, `fraction_in_zone(...)` and `time_in_zone(...)`
beside QGEO1's operators, which keep working. Time-in-zone per shift and day as an API. A
read-only assistant tool listing a machine's zones and recent visits.

## Out of scope throughout

Map drawing (the UI team's). Multi-polygon zones. Speed. Anything crossing the antimeridian.

## Done when (each stage)

`npm run build`, `npm run lint` and `npm run test:db` green. Migration timestamp above
`main`; its down path tested by name with `undoMigrationNamed`.
