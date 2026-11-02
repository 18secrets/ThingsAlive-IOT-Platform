# Geofence fleet map: page contract for the UI team

Task QGEO2. The backend serves this page; the UI team builds it (`frontend/` is theirs).
Schema: `fleet-status.v1.schema.json`, next to this file.

## What the page shows

A map of every machine the signed-in person can see, each at its latest position, with
every fence drawn: site boundaries, no-go (restricted) zones, allowed zones and route
corridors. Each machine is marked inside or outside, and red when it is breaking a rule.

## Calls

| purpose | call | capability |
|---|---|---|
| The whole map | `GET /api/v1/geofences/fleet-status` | `catalog.read` |
| One site only | `GET /api/v1/geofences/fleet-status?siteId=<plant uuid>` | `catalog.read` |
| A machine's recent visits (side panel) | `GET /api/v1/equipment/:sourceSystem/:externalId/geofence-visits?from=<ISO>` | `catalog.read` |
| Hours in each zone per day (report tab) | `GET /api/v1/geofences/time-in-zone?from=<ISO>&to=<ISO>&timezone=Asia/Kolkata` | `catalog.read` |
| Draw or edit a zone (admin) | `POST /api/v1/geofences`, `PATCH /api/v1/geofences/:id`, `DELETE /api/v1/geofences/:id` | `equipment.write` |

Refresh the map every 60 seconds or so. Positions arrive at the loggers' cadence (10 minutes on
the demo), so polling faster shows nothing new.

## Drawing

- Draw every entry in `zones` once, by its `shape`. Positions are `[longitude, latitude]`, as in
  GeoJSON (Leaflet and Google Maps take latitude first — swap them).
  - `Polygon`: GeoJSON polygon, outer ring then holes.
  - `Circle`: `center` and `radiusM` in metres.
  - `Corridor`: a polyline along `path`, `widthM` wide in total (half each side).
- Suggested styling by `kind`: `allowed` and site boundaries as an outline; `restricted` filled red;
  `corridor` as a wide translucent line.
- Place each machine at `position.lng` / `position.lat`.

## Machine states (read `positionStatus` first)

| `positionStatus` | `violating` | show |
|---|---|---|
| `live` | `false` | normal marker |
| `live` | `true` | red marker. Which zone: the `zones` entry with `violation: true`, by `key` |
| `stale` | either | grey marker at the last known place, with the age (`position.ageSeconds`) |
| `none` | always `false` | not on the map; list it as "no position" with the count from `summary.noPosition` |

`violating: false` with `positionStatus: "none"` means **unknown**, not fine. Never show such a
machine as compliant.

`violation` per zone: true when inside a `restricted` zone, or outside an `allowed` zone, a site
boundary or a `corridor`.

## Example (trimmed)

```json
{
  "asOf": "2026-10-29T05:00:00.000Z",
  "zones": [
    { "key": "site:2f1c…", "id": null, "source": "site-boundary", "code": "site:VIZAG", "name": "Vizag yard",
      "kind": "allowed", "appliesTo": "plant",
      "shape": { "type": "Polygon", "coordinates": [[[73.71, 18.43], [73.73, 18.43], [73.73, 18.45], [73.71, 18.45], [73.71, 18.43]]] } },
    { "key": "zone:8a0d…", "id": "8a0d…", "source": "zone", "code": "DEMO-NOGO-VIZAG", "name": "No-go area (demo), VIZAG",
      "kind": "restricted", "appliesTo": "plant",
      "shape": { "type": "Circle", "center": [73.724, 18.44], "radiusM": 150 } }
  ],
  "machines": [
    { "sourceSystem": "ta-2.0", "externalId": "EX-11", "name": "Komatsu PC210", "site": { "id": "2f1c…", "code": "VIZAG", "name": "Vizag yard" },
      "position": { "lng": 73.724, "lat": 18.44, "at": "2026-10-29T05:00:00.000Z", "ageSeconds": 0, "imei": "3569…" },
      "positionStatus": "live",
      "zones": [ { "key": "site:2f1c…", "inside": true, "violation": false }, { "key": "zone:8a0d…", "inside": true, "violation": true } ],
      "violating": true },
    { "sourceSystem": "ta-2.0", "externalId": "3100092", "name": "Dozer 7", "site": null,
      "position": null, "positionStatus": "none", "zones": [], "violating": false }
  ],
  "summary": { "machines": 2, "live": 1, "stale": 0, "noPosition": 1, "violating": 1 }
}
```

## Errors

`400` for a `siteId` that is not a uuid; `401` without a token; `403` without `catalog.read`.
Errors use the shared envelope, `../error-envelope.schema.json`.

## Demo data

On `demo-construction`, positions are **simulated** (`source: 'simulated'`, like every demo
signal). The seed's top-up writes them for machines whose logger is reporting, and so does the
laptop stream (`scripts/stream-demo-telemetry.ts`, every 20–30 s), from the same function, so the
two agree. Each site gets an invented boundary near Pune and one no-go circle; a boundary
somebody drew is never replaced.

Movement follows the machine type:
- **Tippers, graders** drive: about 8 minutes parked at the loading point, then 12 minutes round
  a ~3.2 km loop (~16 km/h). Some make a haul trip off site, 13:00–15:00 India time.
- **Excavators, loaders** move slowly within ~55 m of their spot; **cranes, piling rigs** ~20 m.
- **Generators, concrete pumps and placing booms, compressors** stay put, with a few metres of
  GPS jitter. They never leave the site or enter the no-go area.
- Some mobile or working machines stand in the no-go area 10:00–11:00, so the map shows a breach.

Machines with no reporting logger show as "no position".
