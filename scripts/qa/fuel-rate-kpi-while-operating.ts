import { writeFileSync } from 'fs';
import { DataSource } from 'typeorm';
import { compileFormula } from '../../src/catalog/formula/formula-compiler';
import { dataSourceOptions } from '../../src/database/data-source';

/**
 * Fuel test report FU-4: every account's `avg_fuel_consumption` KPI becomes litres over
 * running hours, `avg_while_operating(fuel_consumption)`, in place of the mean of every
 * reading, `avg(fuel_consumption)`.
 *
 * Run only after the API that knows `avg_while_operating` is deployed: before that, the
 * live evaluator cannot run the new plan and every machine page would lose the KPI.
 *
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/fuel-rate-kpi-while-operating.ts            # dry run
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/fuel-rate-kpi-while-operating.ts --apply    # write
 *
 * Touches only rows whose expression is exactly the old one, so an account that wrote its
 * own definition keeps it, and running it twice changes nothing the second time. Before
 * writing, every row it will change is saved to fuel-rate-kpi-backup-<time>.json, which is
 * what an undo restores (expression, compiled_plan, compiled_at, compiler_version).
 */
const OLD = 'avg(fuel_consumption)';
const NEW = 'avg_while_operating(fuel_consumption)';

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the owner\'s login).');
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  try {
    await ds.transaction(async (m) => {
      const rows: { id: string; tenant_id: string; client_equipment_class_slug: string; expression: string;
        compiled_plan: unknown; compiled_at: Date; compiler_version: string; result_unit: string }[] = await m.query(
        `SELECT "id", "tenant_id", "client_equipment_class_slug", "expression", "compiled_plan", "compiled_at",
                "compiler_version", "result_unit"
           FROM "client_formula"
          WHERE "formula_key" = 'avg_fuel_consumption' AND btrim("expression") = $1
          ORDER BY "tenant_id", "client_equipment_class_slug"
          FOR UPDATE`,
        [OLD],
      );
      console.log(`${rows.length} avg_fuel_consumption formula(s) still read "${OLD}".`);
      if (!rows.length || !apply) {
        if (!apply) console.log('Dry run: nothing written. Add --apply to write.');
        return;
      }
      const backup = `fuel-rate-kpi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(backup, JSON.stringify(rows, null, 2), 'utf-8');
      console.log(`Saved the ${rows.length} row(s) as they were to ${backup}.`);
      for (const r of rows) {
        const compiled = compileFormula({
          formulaKey: 'avg_fuel_consumption', expression: NEW, classSlug: r.client_equipment_class_slug,
          expectedSignals: [{ signal: 'fuel_consumption', unit: r.result_unit || 'L/h' }],
        });
        if (compiled.resultUnit !== r.result_unit) {
          throw new Error(`${r.tenant_id}/${r.client_equipment_class_slug}: unit would change from ${r.result_unit} to ${compiled.resultUnit}; nothing written.`);
        }
        await m.query(
          `UPDATE "client_formula"
              SET "expression" = $2, "compiled_plan" = $3::jsonb, "compiled_at" = now(), "compiler_version" = $4,
                  "updated_by" = 'fuel-report-FU-4', "updated_at" = now()
            WHERE "id" = $1 AND btrim("expression") = $5`,
          [r.id, NEW, JSON.stringify(compiled.plan), compiled.compilerVersion, OLD],
        );
      }
      console.log(`Rewrote ${rows.length} formula(s) to "${NEW}".`);
    });
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
