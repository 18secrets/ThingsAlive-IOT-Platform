import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A client's own copy of a class formula (task QGRANT0).
 *
 * `copy-on-grant.service.ts` has never copied `equipment_class_formula` — not the
 * named ones task QCE3 added, not the hand-written ones that have existed since
 * QCE1. A tenant granted a class received a machine with no KPIs; the client
 * machine page (D29, D30) is built on exactly these formulas. Found by reading the
 * file, not by a failing test — which is the real defect, not the missing copy
 * itself. See `1758090000000-ClassContentInventory.ts` for the fix that makes this
 * class of omission impossible to repeat silently.
 *
 * Same shape as `client_equipment_class` / `client_scenario`
 * (`1757690000000-ClientOwnedCatalog.ts`): tenant-owned, row-level security, no
 * platform write path at all.
 */
export class ClientFormula1758080000000 implements MigrationInterface {
  name = 'ClientFormula1758080000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "client_formula" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "formula_key" text NOT NULL,
        "kind" text NOT NULL,
        "expression" text NOT NULL,
        "compiled_plan" jsonb,
        "compiled_at" timestamptz,
        "compiler_version" text,
        "result_unit" text,
        "required_signals" text[] NOT NULL DEFAULT '{}'::text[],
        "required_parameters" text[] NOT NULL DEFAULT '{}'::text[],
        "named_formula_slug" text,
        "named_formula_version" int,
        "bindings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "result_kind" text,
        "display_unit" text,
        "display_format" text NOT NULL DEFAULT 'number:1',
        "target_value" double precision,
        "target_min" double precision,
        "target_max" double precision,
        "target_direction" text NOT NULL DEFAULT 'none',
        "comparison_basis" text NOT NULL DEFAULT 'none',
        "aggregation_window" text NOT NULL DEFAULT 'shift',
        "chart_type" text NOT NULL DEFAULT 'none',
        "template_version" int,
        "copied_at" timestamptz,
        "status" text NOT NULL DEFAULT 'active',
        "updated_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_client_formula" ON "client_formula"
        ("tenant_id", "client_equipment_class_slug", "formula_key")`,
    );
    await q.query(
      `CREATE INDEX "ix_client_formula_class" ON "client_formula" ("tenant_id", "client_equipment_class_slug")`,
    );

    await q.query(`ALTER TABLE "client_formula" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_formula" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_formula"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_formula" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "client_formula"`);
    await q.query(`DROP TABLE IF EXISTS "client_formula"`);
  }
}
