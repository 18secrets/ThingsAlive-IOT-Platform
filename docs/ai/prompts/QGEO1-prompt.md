# QGEO1 — site boundaries and inside/outside

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `feature/site-geofence`, stacked on QCAT1 (!70) — merge after it.

**Stream B.** Touches `plant` (a boundary column and its route), `src/catalog/formula/` and the
evaluator. Append to `operator-registry.ts`, never reorder. No npm dependency, no PostGIS.

Drafted at the user's instruction from `docs/ai/analysis/itdc-coverage-analysis.md` §4b. The
user chose a TypeScript point-in-polygon over PostGIS, which Railway's Postgres image lacks.

---

## 0. Why

`latitude` and `longitude` are two numeric signals today: enough to see a machine has not
moved, not enough to say it left its site. Fuel theft's strongest clause and ITDC case 5 need
inside/outside.

## 1. A site has a boundary

`plant.boundary jsonb NULL` — a GeoJSON `Polygon`: an outer ring, optional hole rings,
`[longitude, latitude]` positions, each ring closed and with at least four positions.

The database refuses a malformed one (a CHECK over an immutable validation function), so no
path can store a boundary the operators would then misread. Set with
`PUT /api/v1/equipment/plants/:id/boundary` under `equipment.write`, the same capability that
edits the site; `null` removes it.

## 2. Operators

| operator | result | meaning |
|---|---|---|
| `outside_site(latitude, longitude)` | dimensionless 0/1 | is the latest position outside the site |
| `fraction_outside_site(latitude, longitude)` | dimensionless | share of time outside, time-weighted |

- Both series arguments are signals by name and must share a unit.
- **Pairing:** a latitude reading takes the latest longitude reading at or before it, within
  five minutes. Unpaired readings are dropped — a position is both halves or nothing.
- Time-weighted as QCAT1 is: each position holds until the next.
- A point exactly on the boundary is **inside**. A site is drawn generously; a machine parked
  on the line has not left.
- Planar ray casting over longitude/latitude. Accurate at site scale, which is the only scale
  a site boundary has. No polygon crosses the antimeridian here; say so rather than handle it.

## 3. When there is no boundary

A machine with no site, or a site with no boundary, reads `not_configured`, reason
`site_boundary_not_set`. Never "inside" — an unfenced site is not a site the machine is in.
No positions in the window is `no_readings`.

## 4. Out of scope

- Map drawing — the UI's.
- Multi-polygon sites, distance-to-boundary, speed.
- Geofence alert rules — a threshold on `outside_site` already expresses one.

## 5. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after naming the
base SHA. Migration timestamp above `main`; down path named with `undoMigrationNamed`.
