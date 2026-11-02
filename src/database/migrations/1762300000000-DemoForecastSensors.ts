import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The demo class forecasts the three signals its failure modes watch.
 *
 * `seed:demo` now declares coolant, hydraulic oil temperature and oil pressure forecast-
 * enabled (24 h), but a demo seeded before that keeps its rows, and the seed does not run
 * twice. Without the declaration the TTM pass finds nothing to forecast and the
 * recommendation engine has no band to read, however long the readings stream in.
 *
 * Only the seed-only class: `seed_only` is set on the demo class and never on library
 * content (`SeedOnlyClass1758900000000`), so on an environment with no demo this changes
 * nothing.
 */
export class DemoForecastSensors1762300000000 implements MigrationInterface {
  name = 'DemoForecastSensors1762300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "equipment_class_sensor_requirement" r
         SET "forecast_enabled" = true, "forecast_horizon_hours" = 24
       WHERE r."class_slug" = 'demo-excavator'
         AND r."measurement_role" IN ('engine_coolant_temperature', 'hydraulic_oil_temperature', 'engine_oil_pressure')
         AND EXISTS (SELECT 1 FROM "equipment_class_profile" c
                      WHERE c."slug" = r."class_slug" AND c."version" = r."class_version" AND c."seed_only")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "equipment_class_sensor_requirement" r
         SET "forecast_enabled" = false, "forecast_horizon_hours" = NULL
       WHERE r."class_slug" = 'demo-excavator'
         AND r."measurement_role" IN ('engine_coolant_temperature', 'hydraulic_oil_temperature', 'engine_oil_pressure')
         AND EXISTS (SELECT 1 FROM "equipment_class_profile" c
                      WHERE c."slug" = r."class_slug" AND c."version" = r."class_version" AND c."seed_only")`);
  }
}
