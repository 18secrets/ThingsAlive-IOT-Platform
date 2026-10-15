import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sensors imported before the fix get the parameters their signal links already name
 * (tester bug TC_123, 2026-10-15).
 *
 * A catalog import wrote `sensor_role_capability` rows — this sensor provides that
 * signal, on this parameter, in this unit — but never added the parameter to the
 * sensor's own `parameter_specs`. A tool mapping may only name a parameter its sensor
 * declares, so every sensor imported that way was impossible to wire to a device
 * until somebody re-typed its channels by hand. The importer now adds them as it
 * applies; this backfills what was imported before it did.
 *
 * Same rule as the importer: only a parameter the sensor does not already declare is
 * added, so a spec somebody wrote by hand — and its range — is never touched. The
 * capability carries no range, so min and max are null, not an invented 0–0. A row
 * with no parameter_key names its channel by its signal, as apply reads it.
 *
 * The added specs carry their own note so the down path removes exactly them and
 * nothing an admin wrote, nor anything a later import added.
 */
const NOTE = 'Backfilled from catalog-import signal links: set the expected range.';

export class SensorParametersFromCapabilities1760500000000 implements MigrationInterface {
  name = 'SensorParametersFromCapabilities1760500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      WITH wanted AS (
        SELECT c.sensor_id,
               COALESCE(c.parameter_key, c.measurement_role) AS parameter,
               -- One unit per parameter; two links disagreeing on it is an authoring
               -- slip the admin resolves, and either reading beats an empty unit.
               MIN(COALESCE(c.canonical_unit, '')) AS unit
          FROM sensor_role_capability c
         GROUP BY 1, 2
      ),
      missing AS (
        SELECT w.*
          FROM wanted w
          JOIN sensor s ON s.id = w.sensor_id
         WHERE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(s.parameter_specs, '[]'::jsonb)) e
            WHERE e->>'parameter' = w.parameter
         )
      ),
      added AS (
        SELECT sensor_id,
               jsonb_agg(jsonb_build_object(
                 'parameter', parameter, 'unit', unit, 'min', NULL, 'max', NULL,
                 'normalRange', '', 'notes', $1::text
               ) ORDER BY parameter) AS specs
          FROM missing
         GROUP BY sensor_id
      )
      UPDATE sensor s
         SET parameter_specs = COALESCE(s.parameter_specs, '[]'::jsonb) || a.specs
        FROM added a
       WHERE s.id = a.sensor_id`, [NOTE]);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE sensor
         SET parameter_specs = (
           SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
             FROM jsonb_array_elements(parameter_specs) e
            WHERE e->>'notes' IS DISTINCT FROM $1::text
         )
       WHERE parameter_specs @> jsonb_build_array(jsonb_build_object('notes', $1::text))`, [NOTE]);
  }
}
