import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required.');
}

async function main() {
  process.env.DATABASE_URL = connectionString;
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  console.log('Connected to DB');

  const classes = [
    'hydraulic-excavator',
    'heavy-crawler-crane',
    'prime-diesel-generator',
    'screw-air-compressor',
    'rotary-piling-rig',
    'rock-tipper-truck',
  ];

  // 1. Copy equipment_class_formula from demo-excavator to the new classes
  for (const cls of classes) {
    await ds.query(`
      INSERT INTO equipment_class_formula (
        class_slug, class_version, formula_key, kind, expression, inputs, output_unit, basis,
        "references", status, approved_by, approved_at, version, compiled_plan, compiled_at,
        compiler_version, source, import_batch_id, named_formula_slug, named_formula_version,
        bindings, result_kind, display_unit, display_format, target_value, target_min, target_max,
        target_direction, comparison_basis, aggregation_window, chart_type, result_unit,
        required_signals, required_parameters, created_at
      )
      SELECT $1, f.class_version, f.formula_key, f.kind, f.expression, f.inputs, f.output_unit, f.basis,
             f."references", f.status, f.approved_by, f.approved_at, f.version, f.compiled_plan, f.compiled_at,
             f.compiler_version, f.source, f.import_batch_id, f.named_formula_slug, f.named_formula_version,
             f.bindings, f.result_kind, f.display_unit, f.display_format, f.target_value, f.target_min, f.target_max,
             f.target_direction, f.comparison_basis, f.aggregation_window, f.chart_type, f.result_unit,
             f.required_signals, f.required_parameters, f.created_at
        FROM equipment_class_formula f
       WHERE f.class_slug = 'demo-excavator'
         AND NOT EXISTS (
           SELECT 1 FROM equipment_class_formula ex
            WHERE ex.class_slug = $1
              AND ex.formula_key = f.formula_key
              AND ex.class_version = f.class_version
         )
    `, [cls]);
  }
  console.log('✅ Copied equipment_class_formula to all classes');

  // 2. Copy client_formula from demo-excavator to the new classes
  for (const cls of classes) {
    await ds.query(`
      INSERT INTO client_formula (
        tenant_id, client_equipment_class_slug, formula_key, kind, expression,
        compiled_plan, compiled_at, compiler_version, result_unit, required_signals,
        required_parameters, named_formula_slug, named_formula_version, bindings,
        result_kind, display_unit, display_format, target_value, target_min, target_max,
        target_direction, comparison_basis, aggregation_window, chart_type,
        template_version, copied_at, status, source, proposal_id, updated_by, created_at, updated_at
      )
      SELECT f.tenant_id, $1, f.formula_key, f.kind, f.expression,
             f.compiled_plan, f.compiled_at, f.compiler_version, f.result_unit, f.required_signals,
             f.required_parameters, f.named_formula_slug, f.named_formula_version, f.bindings,
             f.result_kind, f.display_unit, f.display_format, f.target_value, f.target_min, f.target_max,
             f.target_direction, f.comparison_basis, f.aggregation_window, f.chart_type,
             f.template_version, f.copied_at, f.status, f.source, f.proposal_id, f.updated_by, f.created_at, f.updated_at
        FROM client_formula f
       WHERE f.tenant_id = 'demo-construction'
         AND f.client_equipment_class_slug = 'demo-excavator'
         AND NOT EXISTS (
           SELECT 1 FROM client_formula ex
            WHERE ex.tenant_id = 'demo-construction'
              AND ex.client_equipment_class_slug = $1
              AND ex.formula_key = f.formula_key
         )
    `, [cls]);
  }
  console.log('✅ Copied client_formula to all classes');

  // 3. Test evaluating for EX-01
  const bindings = new SignalBindingService(ds);
  const kpis = new KpiEvaluatorService(ds, bindings);
  const scope = { tenantId: 'demo-construction', userId: 'u1', roles: ['admin'], isPlatformRole: false };
  const res = await kpis.evaluateAll(scope, { sourceSystem: 'seed-demo', externalId: 'EX-01' }, new Date());
  console.log('\n📊 Evaluated KPIs for EX-01 count:', res.length);
  for (const r of res) {
    const val = (r as any).value !== undefined ? (r as any).value : `${(r as any).points?.length} points`;
    console.log(` - ${r.formulaKey}: readiness=${r.readiness}, value=${val}, reason=${r.reason}`);
  }

  await ds.destroy();
}

main().catch(console.error);
