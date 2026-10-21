# Q08S slice 1 — schema

Branch `feature/ai-layer`. Status: **done, 17 tests green.**

## What landed

`src/database/migrations/1757960000000-SignalBindings.ts` creates four tenant-owned
tables, all under the `tenant_isolation` policy, all FORCEd, all granted to `ta_app`:

| Table | Holds |
|---|---|
| `signal_binding_version` | which signal on which machine comes from which source, in which unit, valid over which half-open window |
| `calibration_version` | identity / two-point / multipoint, with the basis identity requires |
| `sensor_instance` | a device-catalog `sensor` definition fitted at a position on one machine |
| `equipment_parameter` | approved scalars a formula needs and telemetry never carries — tank capacity, service interval |

## The rules that live in the database

- **`ex_signal_binding_primary`** — EXCLUDE over (tenant, equipment, signal, component) and
  the validity range, `WHERE is_primary AND status = 'active'`. One primary per role per
  instant. Proposals are outside it on purpose: several candidates may sit unreviewed, and
  choosing between them is the review.
- **`component_id NOT NULL DEFAULT ''`** — a NULL never compares equal in an exclusion
  constraint, so nullable would have let two whole-machine primaries through while the
  constraint read correctly in `pg_constraint`.
- **`ck_calibration_identity_basis`** — identity calibration requires a stated basis.
- **`uq_equipment_parameter_approved`** — exactly one approved value per parameter per
  machine; unlimited proposals.
- **`ck_signal_binding_discovered_by`** — provenance as an enum, because auto-approval keys
  off it rather than off action type.

## Known, and not papered over

A backwards validity window is refused by the range constructor in the generated `validity`
column, before `ck_signal_binding_validity` is evaluated. The message names no table, column
or constraint. The CHECK stays to state intent; the usable 422 must come from the service
validating before it inserts. Tracked for slice 2.

## Next slice

Entities, discovery (reading `tool_mapping` and `sensor_map_projection` as two independent
sources), coverage against the class's required `expected_signals`, `resolveBinding` at event
time, and the routes.
