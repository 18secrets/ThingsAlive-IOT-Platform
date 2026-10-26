import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Active bindings with no reporting period take the one their device's other active
 * bindings on the same machine agree on.
 *
 * Bindings activated from discovery were saved without `expected_period_seconds`
 * (the activate path took none), and the KPI evaluator reads a missing period as
 * 300 s. A sensor reporting every 600 s then reads half covered and every KPI on it
 * `insufficient_coverage` — EX-01's fuel_level on dev, beside six siblings at 600 s.
 * `SignalBindingService.activate` now inherits the period the same way; this mends the
 * rows made before it did.
 *
 * Only where the siblings agree on one period. Where they disagree, or there are
 * none, the row stays null: a guessed cadence would misstate coverage either way.
 *
 * Down leaves the periods in place. The null was the defect; putting it back would
 * break coverage again, and the filled rows are not otherwise told apart.
 */
export class BindingPeriodFromSiblings1762400000000 implements MigrationInterface {
  name = 'BindingPeriodFromSiblings1762400000000';

  public async up(q: QueryRunner): Promise<void> {
    // Every tenant's rows: the table's RLS is forced, and a login that is not a superuser
    // would otherwise see none of them and update nothing, silently. Transaction-local.
    await q.query(`SELECT set_config('ta.bypass', 'on', true)`);
    await q.query(`
      UPDATE "signal_binding_version" b
         SET "expected_period_seconds" = s.period
        FROM (
          SELECT "tenant_id", "source_system", "external_id", "imei", min("expected_period_seconds") AS period
            FROM "signal_binding_version"
           WHERE "is_primary" AND "status" = 'active' AND "imei" IS NOT NULL AND "expected_period_seconds" IS NOT NULL
           GROUP BY 1, 2, 3, 4
          HAVING count(DISTINCT "expected_period_seconds") = 1
        ) s
       WHERE b."is_primary" AND b."status" = 'active' AND b."expected_period_seconds" IS NULL
         AND b."tenant_id" = s."tenant_id" AND b."source_system" = s."source_system"
         AND b."external_id" = s."external_id" AND b."imei" = s."imei"`);
  }

  public async down(): Promise<void> {
    // Intentionally empty: see the class comment.
  }
}
