import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import {
  DEMO_TENANT,
  DEMO_SIGNALS,
  demoValue,
  local,
  prng,
} from '../src/database/seeds/seed-demo';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { BaselineService } from '../src/prediction/services/baseline.service';

const NEW_MACHINES = [
  { id: 'EX-05', source: 'seed-demo', imei: '358000000000500' },
  { id: 'EX-08', source: 'ta-2.0', imei: '356938035643825' },
  { id: 'EX-09', source: 'ta-2.0', imei: '356938035643833' },
  { id: 'EX-10', source: 'ta-2.0', imei: '356938035643841' },
  { id: 'EX-11', source: 'ta-2.0', imei: '356938035643858' },
  { id: 'EX-12', source: 'ta-2.0', imei: '356938035643866' },
  { id: 'EX-13', source: 'ta-2.0', imei: '356938035643874' },
  { id: 'EX-14', source: 'ta-2.0', imei: '356938035643882' },
  { id: 'EXC-001', source: 'ta-2.0', imei: '356938035643809' },
];

async function run() {
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  console.log('✅ Connected to database.');

  await ds.query(`SELECT ensure_telemetry_partition('2026-09-01'::date)`);
  await ds.query(`SELECT ensure_telemetry_partition('2026-10-01'::date)`);
  console.log('✅ Telemetry partitions for Sep & Oct 2026 ensured.');

  const now = Date.now();
  const DAY_MS = 86_400_000;
  const STEP_MS = 600_000; // 10 minutes
  const start = now - 40 * DAY_MS; // 40 days of history (> 14 days required for baseline)
  const end = now - 3600_000;

  const times: number[] = [];
  for (let t = start; t <= end; t += STEP_MS) times.push(t);
  console.log(`⏱️ Generating ${times.length} ticks across 40 days for ${NEW_MACHINES.length} machines...`);

  const dates = times.map((t) => new Date(t));

  for (const m of NEW_MACHINES) {
    console.log(`\n⏳ Seeding 40-day history for ${m.id} (IMEI ${m.imei})...`);
    const numId = Number(m.id.replace(/[^0-9]/g, '')) || 7;
    const demoMachine = {
      externalId: m.id,
      name: m.id,
      state: 'healthy' as const,
      historyDays: 40,
      endDaysAgo: 0,
      unbound: [],
      expect: '',
    };

    for (const [index, s] of DEMO_SIGNALS.entries()) {
      const noise = prng(numId * 101 + index);
      const values = times.map((t) => demoValue(demoMachine, s.signal, t, now, noise));

      // Batch insert in chunks of 1500
      for (let i = 0; i < times.length; i += 1500) {
        const sliceDates = dates.slice(i, i + 1500);
        const sliceValues = values.slice(i, i + 1500);
        await ds.query(`
          INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
          SELECT $1, $2, $3, v, $4, ts, ts, 'simulated'
            FROM unnest($5::timestamptz[], $6::double precision[]) AS r(ts, v)
          ON CONFLICT DO NOTHING
        `, [DEMO_TENANT, m.imei, s.signal, s.unit, sliceDates, sliceValues]);
      }
    }

    // Fuel consumption
    const fuelValues = times.map((t) => {
      const { hour, dow } = local(t);
      const on = dow >= 1 && dow <= 5 && hour >= 8 && hour < 18;
      const noiseFuel = prng(numId * 313 + Math.floor(t / STEP_MS) * 6271)();
      return on ? parseFloat((12.4 + noiseFuel * 1.5).toFixed(2)) : 0;
    });

    for (let i = 0; i < times.length; i += 1500) {
      const sliceDates = dates.slice(i, i + 1500);
      const sliceValues = fuelValues.slice(i, i + 1500);
      await ds.query(`
        INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
        SELECT $1, $2, 'fuel_consumption', v, 'L/h', ts, ts, 'simulated'
          FROM unnest($3::timestamptz[], $4::double precision[]) AS r(ts, v)
        ON CONFLICT DO NOTHING
      `, [DEMO_TENANT, m.imei, sliceDates, sliceValues]);
    }

    console.log(`✅ 40-day telemetry inserted for ${m.id}`);

    // Compute statistical baseline
    const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
    const baselineService = new BaselineService(ds);
    const baselines = await baselineService.refresh(adminScope, { sourceSystem: m.source, externalId: m.id });
    console.log(`📊 Baseline written for ${m.id}: ${baselines.length} signals aggregated over 30 days.`);
  }

  // Evaluate KPIs on EX-10 (from user screenshot)
  console.log('\n🔎 Evaluating KPIs on EX-10...');
  const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const bindings = new SignalBindingService(ds);
  const kpi = new KpiEvaluatorService(ds, bindings);
  const res = await kpi.evaluateAll(adminScope as any, { sourceSystem: 'ta-2.0', externalId: 'EX-10' }, new Date());

  console.log('\n================ EX-10 KPI RESULTS ================');
  for (const r of res) {
    const isBaseline = r.formulaKey.includes('baseline');
    console.log(
      `${isBaseline ? '⭐' : '  '} ${r.formulaKey.padEnd(25)} => readiness: ${r.readiness.padEnd(14)} reason: ${(r.reason || 'none').padEnd(26)} val: ${
        Array.isArray(r.value) ? `series[${r.value.length}]` : r.value
      }`
    );
  }
  console.log('===================================================\n');

  await ds.destroy();
}

run().catch(console.error);
