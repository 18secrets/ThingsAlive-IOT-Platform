import { MigrationInterface, QueryRunner } from 'typeorm';

/** The constraint as Oee1759900000000 left it: down puts exactly this back. */
const BEFORE = `
  CASE
    WHEN jsonb_typeof("value") = 'null' THEN true
    WHEN "name" = 'currency' THEN
      jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
    WHEN jsonb_typeof("value") <> 'number' THEN false
    WHEN "name" IN ('stale_after_seconds', 'shield_due_soon_days') THEN
      ("value" #>> '{}')::numeric > 0
      AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
    WHEN "name" = 'nominal_fuel_per_hour' THEN
      ("value" #>> '{}')::numeric > 0
    WHEN "name" = 'idle_breakdown_threshold_minutes' THEN
      ("value" #>> '{}')::numeric >= 5
      AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
    ELSE true
  END`;

/**
 * The pump logger's P-code lines become operational parameters (Motor Monitor
 * integration spec, 24 Nov 2026: "all thresholds configurable"; p-code-rules.ts).
 *
 * Only the value needs the database: the names are the catalog's, as every parameter's
 * are. Each line is a positive number. A zero or negative one is not a stricter or a
 * looser rule, it is a broken one: a dry-run ratio of 0 can never be met and silences
 * P401 on every pump it covers, and a low-voltage line of -1 does the same to P101. The
 * fault job already ignores such a value and keeps the default, but a value it ignores
 * is one the screen would show as set; refusing it here means it is never stored.
 * Same constraint, one more arm: the others are copied unchanged from Oee.
 */
export class MotorPCodeThresholds1766200000000 implements MigrationInterface {
  name = 'MotorPCodeThresholds1766200000000';

  public async up(q: QueryRunner): Promise<void> {
    const arm = `
    WHEN "name" IN ('pcode_low_voltage', 'pcode_high_voltage', 'pcode_overheat_temp',
                    'pcode_dry_run_ratio', 'pcode_overload_ratio', 'pcode_locked_rotor_ratio') THEN
      ("value" #>> '{}')::numeric > 0
    ELSE true`;
    const after = BEFORE.replace(/\n\s*ELSE true/, arm);
    if (after === BEFORE) throw new Error('MotorPCodeThresholds: could not place the new arm');
    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value" CHECK (${after})`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value" CHECK (${BEFORE})`);
  }
}
