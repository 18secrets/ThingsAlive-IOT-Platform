import { MigrationInterface, QueryRunner } from 'typeorm';
import { compileFormula } from '../../catalog/formula/formula-compiler';
import { RoleInput } from '../../catalog/formula/named-formula-binding';

interface SeedFormula {
  slug: string;
  name: string;
  description: string;
  category: string;
  expression: string;
  inputs: RoleInput[];
}

/**
 * Seven published named formulas, as real platform content (task QCE3 §7) — straight
 * from the ITDC coverage analysis (`docs/ai/analysis/itdc-coverage-analysis.md` §2),
 * compiled for real by the same compiler a hand-written formula goes through, not
 * hand-typed JSON. `result_dimension` and `result_kind` are left for the compiler to
 * infer and persist (D32's pattern) rather than declared and risked disagreeing with
 * what the compiler actually produces.
 */
const SEED_FORMULAS: SeedFormula[] = [
  {
    slug: 'specific_fuel_consumption', name: 'Specific fuel consumption',
    description: 'Fuel burned per unit of power delivered — lower is more efficient.',
    category: 'fuel', expression: 'fuel_rate / power_output',
    inputs: [
      { role: 'fuel_rate', dimension: 'L/h', description: 'Instantaneous fuel consumption rate.' },
      { role: 'power_output', dimension: 'kW', description: 'Instantaneous power delivered.' },
    ],
  },
  {
    slug: 'fuel_per_hour', name: 'Fuel per hour',
    description: 'Fuel consumption rate, reduced over the window — the drift signal in ITDC\'s fuel-efficiency use case.',
    category: 'fuel', expression: 'avg(fuel_rate)',
    inputs: [{ role: 'fuel_rate', dimension: 'L/h', description: 'Instantaneous fuel consumption rate.' }],
  },
  {
    slug: 'load_factor', name: 'Load factor',
    description: 'Actual power against rated power — how hard the machine is working.',
    category: 'performance', expression: 'actual_power / rated_power',
    inputs: [
      { role: 'actual_power', dimension: 'kW', expectedParameters: ['power'] },
      { role: 'rated_power', dimension: 'kW', expectedParameters: ['power'] },
    ],
  },
  {
    slug: 'temperature_rise', name: 'Temperature rise',
    description: 'Outlet temperature above inlet — a cooling-system health indicator.',
    category: 'thermal', expression: 'outlet_temp - inlet_temp',
    inputs: [
      { role: 'outlet_temp', dimension: 'degC', expectedParameters: ['temperature'] },
      { role: 'inlet_temp', dimension: 'degC', expectedParameters: ['temperature'] },
    ],
  },
  {
    slug: 'pressure_differential', name: 'Pressure differential',
    description: 'Upstream pressure above downstream — a filter or restriction indicator.',
    category: 'fluid', expression: 'upstream_pressure - downstream_pressure',
    inputs: [
      { role: 'upstream_pressure', dimension: 'kPa', expectedParameters: ['pressure'] },
      { role: 'downstream_pressure', dimension: 'kPa', expectedParameters: ['pressure'] },
    ],
  },
  {
    slug: 'duty_cycle', name: 'Duty cycle',
    description: 'Running time as a fraction of total time — ITDC\'s utilisation use case.',
    category: 'utilisation', expression: 'running_time / total_time',
    inputs: [
      { role: 'running_time', dimension: 'h' },
      { role: 'total_time', dimension: 'h' },
    ],
  },
  {
    slug: 'co2_from_fuel', name: 'CO2 from fuel',
    description: 'Estimated emissions from fuel burned — ITDC\'s emissions use case, one multiplier on existing data.',
    category: 'emissions', expression: 'fuel_volume * emission_factor',
    inputs: [
      { role: 'fuel_volume', dimension: 'L', description: 'Fuel volume consumed over the period.' },
      { role: 'emission_factor', dimension: 'kg/L', description: 'CO2 mass per unit volume of fuel.' },
    ],
  },
];

export class NamedFormulaCatalogue1758070000000 implements MigrationInterface {
  name = 'NamedFormulaCatalogue1758070000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "named_formula" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "name" text NOT NULL,
        "description" text,
        "category" text,
        "expression" text NOT NULL,
        "inputs" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "result_dimension" text,
        "result_kind" text,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "created_by" text,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "compiled_plan" jsonb,
        "compiled_at" timestamptz,
        "compiler_version" text,
        "result_unit" text
      )`);
    // (slug, version): a published named formula is immutable, so a correction
    // publishes a new version under the same slug (same reason as
    // equipment_class_profile, 1757680000000-Catalog.ts).
    await q.query(`CREATE UNIQUE INDEX "uq_named_formula_version" ON "named_formula" ("slug", "version")`);
    await q.query(`CREATE INDEX "ix_named_formula_slug" ON "named_formula" ("slug")`);
    await q.query(`CREATE INDEX "ix_named_formula_status" ON "named_formula" ("status")`);
    // No DELETE — same reason as every other platform-owned, published-and-immutable
    // table (equipment_class_profile, equipment_class_formula): retiring a named
    // formula is a status change, never a row removed out from under a class that
    // bound it.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "named_formula" TO "ta_app"`);

    // Bind mode (task QCE3 §3) — NULL on every expression-mode row that exists
    // today and every one written from now on that stays expression-mode.
    await q.query(`
      ALTER TABLE "equipment_class_formula"
        ADD COLUMN "named_formula_slug" text,
        ADD COLUMN "named_formula_version" int,
        ADD COLUMN "bindings" jsonb NOT NULL DEFAULT '[]'::jsonb`);

    const now = new Date();
    for (const f of SEED_FORMULAS) {
      const expectedSignals = f.inputs.map((i) => ({ signal: i.role, unit: i.dimension }));
      let compiled: ReturnType<typeof compileFormula>;
      try {
        compiled = compileFormula({
          formulaKey: f.slug, expression: f.expression, classSlug: `named-formula:${f.slug}`, expectedSignals,
        });
      } catch (err) {
        // Not inventing an operator to make a stubborn seed compile (§7) — a seed
        // formula that cannot compile against today's vocabulary is reported, and
        // the migration refuses rather than writing unpublishable content.
        throw new Error(
          `Seed named formula "${f.slug}" ("${f.expression}") does not compile against the `
            + `current operator vocabulary: ${(err as Error).message}`,
        );
      }
      await q.query(
        `INSERT INTO "named_formula"
           (slug, version, name, description, category, expression, inputs, result_kind,
            status, published_at, created_by, compiled_plan, compiled_at, compiler_version, result_unit)
         VALUES ($1, 1, $2, $3, $4, $5, $6::jsonb, $7, 'published', $8, 'migration:QCE3', $9::jsonb, $8, $10, $11)`,
        [
          f.slug, f.name, f.description, f.category, f.expression, JSON.stringify(f.inputs),
          compiled.resultKind, now, JSON.stringify(compiled.plan), compiled.compilerVersion, compiled.resultUnit,
        ],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "equipment_class_formula" DROP COLUMN IF EXISTS "bindings"`);
    await q.query(`ALTER TABLE "equipment_class_formula" DROP COLUMN IF EXISTS "named_formula_version"`);
    await q.query(`ALTER TABLE "equipment_class_formula" DROP COLUMN IF EXISTS "named_formula_slug"`);
    await q.query(`DROP TABLE IF EXISTS "named_formula"`);
  }
}
