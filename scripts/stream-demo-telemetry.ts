import 'reflect-metadata';
process.env.DEMO_FORCE_RUNNING = 'true';
process.env.SEED_DEMO_ENABLED = 'true';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { existsSync } from 'fs';
import { dataSourceOptions } from '../src/database/data-source';
import { demoPosition, demoSiteCentre, ensureDemoGeofences } from '../src/database/seeds/demo-geofence';
import {
  DEMO_CLASS,
  DEMO_MACHINES,
  DEMO_SIGNALS,
  DEMO_SOURCE,
  DEMO_TENANT,
  demoValue,
  imeiOf,
  prng,
  running,
  seedDemo,
  topUpDemo,
  BREACH_TAIL,
  DemoMachine,
  MachineState,
} from '../src/database/seeds/seed-demo';

const TARGET_CLASS = 'hydraulic-excavator';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ForecastService } from '../src/forecast/forecast.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';
import { RecFrameService } from '../src/rec-frame/rec-frame.service';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { withTenantId } from '../src/scope/tenant-session';

/**
 * Parse an interval string like '30s', '1m', '2h', '7200s' into milliseconds.
 */
export function parseIntervalMs(raw?: string, fallbackMs = 30_000): number {
  if (!raw) return fallbackMs;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(h|m|s|ms)?$/i);
  if (!match) return fallbackMs;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  switch (unit) {
    case 'h': return Math.round(num * 3600 * 1000);
    case 'm': return Math.round(num * 60 * 1000);
    case 's': return Math.round(num * 1000);
    case 'ms': return Math.round(num);
    default: return fallbackMs;
  }
}

export interface FleetMachine {
  externalId: string;
  sourceSystem: string;
  imei: string;
  state: MachineState;
}

export const ALL_FLEET_MACHINES: FleetMachine[] = [
  { externalId: 'EX-01', sourceSystem: 'seed-demo', imei: '358000000000100', state: 'healthy' },
  { externalId: 'EX-02', sourceSystem: 'seed-demo', imei: '358000000000200', state: 'trending' },
  { externalId: 'EX-03', sourceSystem: 'seed-demo', imei: '358000000000300', state: 'breaching' },
  // Quiet on purpose: EX-04 is the demo's offline machine (seed-demo's "Gone quiet").
  // Streaming it makes every machine look online. --include-quiet still wakes it.
  { externalId: 'EX-04', sourceSystem: 'seed-demo', imei: '358000000000400', state: 'quiet' },
  { externalId: 'EX-05', sourceSystem: 'seed-demo', imei: '358000000000500', state: 'healthy' },
  { externalId: 'EX-06', sourceSystem: 'seed-demo', imei: '358000000000600', state: 'healthy' },
  { externalId: 'EX-08', sourceSystem: 'ta-2.0', imei: '356938035643825', state: 'healthy' },
  { externalId: 'EX-09', sourceSystem: 'ta-2.0', imei: '356938035643833', state: 'healthy' },
  { externalId: 'EX-10', sourceSystem: 'ta-2.0', imei: '356938035643841', state: 'healthy' },
  { externalId: 'EX-11', sourceSystem: 'ta-2.0', imei: '356938035643858', state: 'healthy' },
  { externalId: 'EX-12', sourceSystem: 'ta-2.0', imei: '356938035643866', state: 'healthy' },
  { externalId: 'EX-13', sourceSystem: 'ta-2.0', imei: '356938035643874', state: 'healthy' },
  { externalId: 'EX-14', sourceSystem: 'ta-2.0', imei: '356938035643882', state: 'healthy' },
  { externalId: 'EXC-001', sourceSystem: 'ta-2.0', imei: '356938035643809', state: 'healthy' },
];

/**
 * The machines this run streams: those of ALL_FLEET_MACHINES whose logger is fitted to
 * a machine in this database. The list above spans two setups (seed-demo's EX-01..06
 * and the EX-08.. fleet that onboard-all-machines.ts registers); streaming a logger no
 * machine owns writes readings nothing shows, and still counts it as a device online.
 */
let fleet: FleetMachine[] = ALL_FLEET_MACHINES;

/** Each streamed machine's site centre and type, for its simulated GPS (QGEO2 fleet map). */
const gpsOf = new Map<string, { centre: [number, number]; typeText: string }>();

/**
 * Draws demo site boundaries and no-go zones where missing, and notes where each machine
 * works and what it is — a tipper drives, a generator does not. The same positions as the
 * seed's top-up, so the two writers never disagree about where a machine is.
 */
async function loadGeofences(ds: DataSource): Promise<void> {
  const rows: { externalId: string; plantId: string | null; plantCode: string | null; typeText: string }[] = await ds.query(
    `SELECT e.external_id AS "externalId", p.id AS "plantId", p.code AS "plantCode",
            concat_ws(' ', e.equipment_class_slug, c.name, e.name) AS "typeText"
       FROM equipment_profile e
       LEFT JOIN plant p ON p.id = e.plant_id
       LEFT JOIN client_equipment_class c ON c.tenant_id = e.tenant_id AND c.slug = e.equipment_class_slug
      WHERE e.tenant_id = $1 AND e.external_id = ANY($2::text[])`,
    [DEMO_TENANT, fleet.map((m) => m.externalId)],
  );
  const plants = new Map<string, string>();
  for (const r of rows) {
    if (r.plantId && r.plantCode) plants.set(r.plantId, r.plantCode);
    gpsOf.set(r.externalId, { centre: demoSiteCentre(r.plantCode ?? `machine:${r.externalId}`), typeText: r.typeText });
  }
  const drawn = await ensureDemoGeofences(ds, DEMO_TENANT, [...plants].map(([id, code]) => ({ id, code })));
  console.log(`[SeedStream] Geofences: ${drawn.boundaries} site boundaries and ${drawn.zones} no-go zones drawn `
    + `(existing ones kept); simulated GPS for ${gpsOf.size} machines.`);
}

async function loadFleet(ds: DataSource): Promise<void> {
  const rows: { imei: string }[] = await ds.query(
    `SELECT imei FROM device_inventory WHERE tenant_id = $1 AND equipment_external_id IS NOT NULL`,
    [DEMO_TENANT],
  );
  const fitted = new Set(rows.map((r) => r.imei));
  fleet = ALL_FLEET_MACHINES.filter((m) => fitted.has(m.imei));
  const skipped = ALL_FLEET_MACHINES.filter((m) => !fitted.has(m.imei)).map((m) => m.externalId);
  if (skipped.length) console.log(`[SeedStream] Not streaming ${skipped.join(', ')}: no fitted logger in this database.`);
}

/**
 * Configure worker command for ForecastService.
 */
function resolveWorkerCommand() {
  const pythonPath = process.env.FORECAST_PYTHON || 'python3';
  const realScript = process.env.FORECAST_WORKER_SCRIPT || join(process.cwd(), 'python', 'forecast', 'infer.py');
  const stubScript = join(process.cwd(), 'test', 'forecast', 'stub-worker.js');

  if (process.env.USE_REAL_WORKER === 'true' && existsSync(realScript)) {
    return { command: pythonPath, args: ['-I', realScript] };
  }
  return {
    command: process.execPath,
    args: [stubScript],
  };
}

let lastEnsuredMonth: string | null = null;

/**
 * Ensures demo setup, forecast declarations, and layout widgets.
 */
async function ensurePrerequisites(ds: DataSource) {
  // 1. Ensure seed demo is populated
  const [{ count: tenantCount }] = await ds.query(
    `SELECT count(*)::int AS count FROM tenant WHERE tenant_id = $1`, [DEMO_TENANT]
  );
  if (tenantCount === 0) {
    console.log(`[SeedStream] Demo tenant "${DEMO_TENANT}" not found. Seeding demo...`);
    process.env.SEED_DEMO_ENABLED = 'true';
    await seedDemo(ds);
    console.log(`[SeedStream] Demo tenant seeded.`);
  }
  // After seeding, so a fresh database's own loggers count; before anything uses the fleet.
  await loadFleet(ds);
  // Fences, sites and machine types for the simulated GPS, once the fleet is known (QGEO2).
  await loadGeofences(ds);

  // 2. Enable forecasting on hydraulic-excavator requirements
  await ds.query(`
    UPDATE equipment_class_sensor_requirement
       SET forecast_enabled = true,
           forecast_horizon_hours = 24
     WHERE class_slug = $1
       AND measurement_role IN ('engine_coolant_temperature', 'engine_oil_pressure')
  `, [TARGET_CLASS]);

  // 3. Ensure forecast_chart widgets exist on the demo layout
  const forecastWidgets = [
    { key: 'coolant_forecast', boundTo: 'engine_coolant_temperature', title: 'Coolant Temp 24h Forecast' },
    { key: 'oil_pressure_forecast', boundTo: 'engine_oil_pressure', title: 'Oil Pressure 24h Forecast' },
  ];
  for (const fw of forecastWidgets) {
    const [{ count }] = await ds.query(
      `SELECT count(*)::int AS count FROM client_equipment_class_layout WHERE tenant_id = $1 AND widget_key = $2`,
      [DEMO_TENANT, fw.key]
    );
    if (count === 0) {
      const [{ maxPos }] = await ds.query(
        `SELECT coalesce(max(position), 0)::int AS "maxPos" FROM client_equipment_class_layout WHERE tenant_id = $1`,
        [DEMO_TENANT]
      );
      await ds.query(
        `INSERT INTO client_equipment_class_layout
          (tenant_id, client_equipment_class_slug, widget_type, widget_key, bound_to, title, position, size, hidden, position_custom)
         VALUES ($1, $2, 'forecast_chart', $3, $4, $5, $6, 'medium', false, false)`,
        [DEMO_TENANT, TARGET_CLASS, fw.key, fw.boundTo, fw.title, maxPos + 1]
      );
      console.log(`[SeedStream] Added ${fw.title} widget to ${DEMO_TENANT} layout.`);
    }
  }

  // 4. Ensure scenario activations on EX-01..EX-06
  const demoMachines = ['EX-01', 'EX-02', 'EX-03', 'EX-04', 'EX-05', 'EX-06'];
  // Activate the scenarios the account actually holds for the demo class, read rather
  // than hard-coded: a slug that does not exist activates nothing, silently, and
  // ThingsCare then shows "no scenario" on every machine.
  const scenarios: string[] = (await ds.query(
    `SELECT slug FROM client_scenario WHERE tenant_id = $1 AND client_equipment_class_slug = $2`,
    [DEMO_TENANT, DEMO_CLASS],
  )).map((r: { slug: string }) => r.slug);
  for (const machine of demoMachines) {
    for (const slug of scenarios) {
      await ds.query(`
        INSERT INTO equipment_scenario (
          tenant_id, source_system, external_id, client_scenario_slug, state, parameter_overrides, blockers_at_activation, activated_at, state_changed_at
        ) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb, '[]'::jsonb, now(), now())
        ON CONFLICT ("tenant_id", "source_system", "external_id", "client_scenario_slug") DO NOTHING
      `, [DEMO_TENANT, DEMO_SOURCE, machine, slug]);
    }
  }

  // 5. Ensure historical residuals exist so confidence intervals & forecast charts are established
  const activeModel = await ds.query(
    `SELECT id FROM forecast_model WHERE status = 'active' LIMIT 1`
  );
  if (activeModel.length > 0) {
    const modelId = activeModel[0].id;
    const [{ count: runCount }] = await ds.query(
      `SELECT count(*)::int AS count FROM forecast_run WHERE model_id = $1`, [modelId]
    );
    let runId: string;
    if (runCount === 0) {
      const [{ id }] = await ds.query(
        `INSERT INTO forecast_run (started_at, finished_at, budget_seconds, model_id, outcome)
         VALUES (now() - interval '1 day', now() - interval '1 day', 60, $1, 'completed') RETURNING id`, [modelId]
      );
      runId = id;
    } else {
      const [{ id }] = await ds.query(
        `SELECT id FROM forecast_run WHERE model_id = $1 ORDER BY started_at DESC LIMIT 1`, [modelId]
      );
      runId = id;
    }

    const residualMachines = fleet;
    const demoSignals = ['engine_coolant_temperature', 'engine_oil_pressure'];

    const resTenantIds: string[] = [];
    const resSources: string[] = [];
    const resExternals: string[] = [];
    const resSignals: string[] = [];
    const resModels: string[] = [];
    const resRuns: string[] = [];
    const resSteps: Date[] = [];
    const resPreds: number[] = [];
    const resActuals: number[] = [];
    const resResiduals: number[] = [];

    for (const machine of residualMachines) {
      for (const signal of demoSignals) {
        const [{ count: daysCount }] = await ds.query(
          `SELECT count(DISTINCT (step_at at time zone 'UTC')::date)::int AS count
             FROM forecast_residual
            WHERE tenant_id = $1 AND external_id = $2 AND signal = $3 AND model_id = $4`,
          [DEMO_TENANT, machine.externalId, signal, modelId]
        );

        if (daysCount < 30) {
          const now = Date.now();
          const DAY_MS = 24 * 3600 * 1000;
          const HOUR_MS = 3600 * 1000;

          for (let d = 40; d >= 1; d--) {
            const dayBase = Math.floor((now - d * DAY_MS) / DAY_MS) * DAY_MS + 10 * HOUR_MS;
            const predBase = signal === 'engine_coolant_temperature' ? 65.0 : 380.0;
            const noise = parseFloat((Math.sin(d + (machine.externalId === 'EX-03' ? 2 : 0)) * 0.8).toFixed(4));
            const actual = predBase + noise;
            const res = actual - predBase;

            resTenantIds.push(DEMO_TENANT);
            resSources.push(machine.sourceSystem);
            resExternals.push(machine.externalId);
            resSignals.push(signal);
            resModels.push(modelId);
            resRuns.push(runId);
            resSteps.push(new Date(dayBase));
            resPreds.push(predBase);
            resActuals.push(actual);
            resResiduals.push(res);
          }
        }
      }
    }

    if (resTenantIds.length > 0) {
      await ds.query(`
        INSERT INTO forecast_residual (
          id, tenant_id, source_system, external_id, signal, model_id, run_id, step_at, lead_steps, predicted, actual, residual, operating
        )
        SELECT gen_random_uuid(), u.tenant_id, u.source_system, u.external_id, u.signal, u.model_id::uuid, u.run_id::uuid, u.step_at, 1, u.predicted, u.actual, u.residual, true
          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::double precision[], $9::double precision[], $10::double precision[])
            AS u(tenant_id, source_system, external_id, signal, model_id, run_id, step_at, predicted, actual, residual)
        ON CONFLICT DO NOTHING
      `, [resTenantIds, resSources, resExternals, resSignals, resModels, resRuns, resSteps, resPreds, resActuals, resResiduals]);
    }
  }

  // 6. Ensure published causal chain for hydraulic-excavator exists
  const [{ count: chainCount }] = await ds.query(
    `SELECT count(*)::int AS count FROM causal_chain WHERE equipment_class_slug = $1 AND status = 'published'`,
    [TARGET_CLASS]
  );
  if (chainCount === 0) {
    const nodes = [
      {
        signal: 'engine_coolant_temperature',
        label: 'Coolant under load',
        intercept: 40,
        direction: 'above',
        warnAbove: 15,
        criticalAbove: 25,
        drivers: [
          { signal: 'engine_load', coefficient: 0.4, lagSeconds: 0 }
        ]
      }
    ];
    await ds.query(`
      INSERT INTO causal_chain (
        slug, version, equipment_class_slug, name, description, outcome, nodes, status, published_at, created_at
      ) VALUES (
        'cooling-circuit-chain', 1, $1, 'Cooling System Thermal Path',
        'Tracks how engine load drives coolant temperature through the cooling circuit.',
        'engine_coolant_temperature', $2::jsonb, 'published', now(), now()
      )
      ON CONFLICT (slug, version) DO UPDATE
        SET nodes = EXCLUDED.nodes, status = 'published', published_at = now()
    `, [TARGET_CLASS, JSON.stringify(nodes)]);
    console.log(`[SeedStream] Published causal chain for ${TARGET_CLASS}.`);
  }

  // 7. Ensure 24/7 continuous shift schedules across all fleet equipment (so baseline KPIs evaluate 24/7)
  await withTenantId(ds, DEMO_TENANT, async (m) => {
    await m.query(`
      UPDATE equipment_shift
         SET start_minute = 0,
             end_minute = 1440,
             days = ARRAY[0,1,2,3,4,5,6],
             -- A week back, not now(): scored_through is where the shift runner resumes,
             -- so now() told it every past shift was already scored and Utilization and
             -- Shift history stayed empty. Only on the first conversion to 24/7, so a
             -- restart does not rewind shifts the runner has since scored.
             scored_through = NOW() - INTERVAL '7 days',
             arrivals_through = NOW() - INTERVAL '7 days'
       WHERE tenant_id = $1
         AND NOT (start_minute = 0 AND end_minute = 1440 AND days = ARRAY[0,1,2,3,4,5,6])
    `, [DEMO_TENANT]);
  });
  console.log(`[SeedStream] 🕒 Configured 24/7 continuous operational shifts for all fleet machines.`);
}

/**
 * Emits simultaneous telemetry for all active demo equipment at exact timestamp `now`.
 * All signals for all active machines are generated in parallel and bulk-inserted in a single query.
 */
export async function emitSimultaneousTick(ds: DataSource, now: Date, includeQuiet = false): Promise<{ count: number; machines: string[] }> {
  const nowMs = now.getTime();
  const tickStep = 30 * 1000;
  const tickIndex = Math.floor(nowMs / tickStep);

  const activeMachines = fleet.filter((m) => m.state !== 'quiet' || includeQuiet);

  const currentMonth = now.toISOString().slice(0, 7);
  if (lastEnsuredMonth !== currentMonth) {
    await ds.query(`SELECT ensure_telemetry_partition($1::date)`, [`${currentMonth}-01`]);
    lastEnsuredMonth = currentMonth;
  }

  const imeis: string[] = [];
  const signals: string[] = [];
  const values: number[] = [];
  const units: string[] = [];

  for (const machine of activeMachines) {
    const imei = machine.imei;
    const numId = Number(machine.externalId.replace(/[^0-9]/g, '')) || 7;
    for (const [index, s] of DEMO_SIGNALS.entries()) {
      let val: number;
      if (machine.state === 'breaching' && s.signal === 'engine_coolant_temperature' && running(nowMs, machine.externalId)) {
        val = BREACH_TAIL[tickIndex % BREACH_TAIL.length];
      } else {
        const noise = prng(numId * 101 + index + tickIndex * 7919);
        val = demoValue({
          externalId: machine.externalId,
          name: machine.externalId,
          state: machine.state,
          historyDays: 90,
          endDaysAgo: 0,
          unbound: [],
          expect: '',
        }, s.signal, nowMs, nowMs, noise);
      }

      imeis.push(imei);
      signals.push(s.signal);
      values.push(parseFloat(val.toFixed(2)));
      units.push(s.unit);
    }

    // Simulated GPS (QGEO2 fleet map), from the same logger as everything else, so the
    // shift pass and the fleet map read it like a real fix.
    const gps = gpsOf.get(machine.externalId);
    if (gps) {
      const [lngNow, latNow] = demoPosition(machine.externalId, gps.centre, nowMs, gps.typeText);
      imeis.push(imei, imei);
      signals.push('latitude', 'longitude');
      values.push(latNow, lngNow);
      units.push('deg', 'deg');
    }

    // Fuel consumption (rate in L/h) for productive quality tracking in OEE
    const noiseFuel = prng(numId * 313 + tickIndex * 6271)();
    const isEngineRunning = running(nowMs, machine.externalId);
    const fuelRate = isEngineRunning ? parseFloat((12.4 + noiseFuel * 1.5).toFixed(2)) : 0;
    imeis.push(imei);
    signals.push('fuel_consumption');
    values.push(fuelRate);
    units.push('L/h');
  }

  // Single bulk unnest insert across all machines & signals simultaneously
  if (imeis.length > 0) {
    await ds.query(`
      INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      SELECT $1, u.imei, u.signal, u.val, u.unit, $6, $6, 'simulated'
        FROM unnest($2::text[], $3::text[], $4::double precision[], $5::text[]) AS u(imei, signal, val, unit)
      ON CONFLICT DO NOTHING
    `, [DEMO_TENANT, imeis, signals, values, units, now]);
  }

  // Update link health for all equipment
  const windowStart = new Date(Math.floor(nowMs / (3600 * 1000)) * (3600 * 1000));

  for (const m of fleet) {
    const isOnline = m.state !== 'quiet' || includeQuiet;
    await ds.query(`
      INSERT INTO device_link_health (
        tenant_id, imei, source_system, external_id, local_date,
        window_start, window_end, state, detail, reported_signals, missing_signals, samples, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT ("tenant_id", "imei", "window_start") DO UPDATE
        SET window_end = EXCLUDED.window_end, state = EXCLUDED.state, detail = EXCLUDED.detail, computed_at = EXCLUDED.computed_at
    `, [
      DEMO_TENANT, m.imei, m.sourceSystem, m.externalId, now.toISOString().slice(0, 10),
      windowStart, now, isOnline ? 'healthy' : 'dark', isOnline ? 'Healthy link (live streaming)' : 'No readings received (offline)',
      isOnline ? ['engine_coolant_temperature', 'engine_oil_pressure', 'engine_speed', 'hydraulic_oil_temperature', 'fuel_level', 'engine_running_status', 'fuel_consumption'] : [],
      isOnline ? [] : ['engine_coolant_temperature', 'engine_oil_pressure', 'engine_speed', 'hydraulic_oil_temperature', 'fuel_level', 'engine_running_status'],
      isOnline ? 120 : 0, now
    ]);
  }

  return { count: imeis.length, machines: activeMachines.map((m) => m.externalId) };
}

/**
 * Runs TTM forecasting, scenario risk scoring, and AI recommendations.
 */
export async function runForecastAndRecommendations(ds: DataSource, now: Date, forceForecast = false) {
  console.log(`[SeedStream] 🔮 Running TTM Forecasting & AI Recommendations at ${now.toISOString()}...`);
  const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };

  // 1. Baselines & Scenario risk scoring
  const [{ count: baselineCount }] = await ds.query(
    `SELECT count(*)::int AS count FROM prediction_baseline WHERE tenant_id = $1`, [DEMO_TENANT]
  );
  if (baselineCount === 0) {
    const baselineService = new BaselineService(ds);
    for (const machine of fleet) {
      try {
        await baselineService.refresh(adminScope, { sourceSystem: machine.sourceSystem, externalId: machine.externalId });
      } catch {}
    }
  }

  const predictionService = new PredictionService(ds);
  let scoredCount = 0;
  for (const machine of fleet) {
    try {
      const res = await predictionService.scoreAsset(adminScope, { sourceSystem: machine.sourceSystem, externalId: machine.externalId }, now);
      scoredCount += res.written.length;
    } catch {
      // Best effort scoring
    }
  }
  console.log(`[SeedStream] 🎯 Deterministic Scenario Risk: Scored ${scoredCount} predictions.`);

  // 2. Forecast pass
  if (forceForecast) {
    await ds.query(`
      UPDATE forecast_latest
         SET generated_at = now() - interval '5 hours',
             context_to = now() - interval '5 hours'
       WHERE tenant_id = $1
    `, [DEMO_TENANT]);
  }

  const signalBindings = new SignalBindingService(ds);
  const kpi = new KpiEvaluatorService(ds, signalBindings);
  const reader = new ForecastReader(kpi);
  const workerCmd = resolveWorkerCommand();
  const forecastService = new ForecastService(ds, kpi, reader, workerCmd);

  const forecastSummary = await forecastService.runPass(now);
  console.log(`[SeedStream] 🔮 Prediction/Forecast Pass: ${forecastSummary.outcome.toUpperCase()} (${forecastSummary.forecast} generated, ${forecastSummary.skipped} skipped)`);

  // 3. AI Recommendations for EX-03
  const recEngine = new RecEngineService(ds);
  const recFrame = new RecFrameService(ds, recEngine);
  try {
    const ev = await recEngine.evaluate(adminScope, { sourceSystem: DEMO_SOURCE, externalId: 'EX-03' });
    const framed = await recFrame.render(adminScope, ev.bundle.id);
    console.log(`[SeedStream] 🤖 AI Recommendation for EX-03: "${framed.answer.summary}"`);
  } catch (err: any) {
    console.warn(`[SeedStream] Recommendation notice: ${err?.message || err}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const includeQuiet = args.includes('--include-quiet') || process.env.STREAM_INCLUDE_QUIET === 'true';

  // Cadence configuration
  let rawInterval: string | undefined;
  const intervalIdx = args.findIndex((a) => a === '--interval' || a === '-i');
  if (intervalIdx !== -1 && args[intervalIdx + 1]) {
    rawInterval = args[intervalIdx + 1];
  } else {
    rawInterval = process.env.STREAM_INTERVAL || process.env.REFRESH_INTERVAL || '30s';
  }

  const requestedMs = parseIntervalMs(rawInterval, 30_000);
  
  // If the user specified a long interval like '2h' or '1h', use it for forecasting,
  // but ALWAYS keep telemetry emission at 30 seconds (or requested if <= 5 minutes).
  let telemetryIntervalMs = 30_000;
  let forecastIntervalMs = 10 * 60 * 1000; // 10 minutes to keep forecasts perpetually fresh against 4h window

  if (requestedMs <= 5 * 60 * 1000) {
    telemetryIntervalMs = requestedMs;
  } else {
    forecastIntervalMs = requestedMs;
  }

  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  console.log(`[SeedStream] 🔗 Connected to database (${process.env.DATABASE_URL ? 'Remote/Railway' : 'Local'})`);

  try {
    await ensurePrerequisites(ds);

    const initialNow = new Date();

    // 1. Fill any historical gap from the database's last reading up to now
    console.log(`[SeedStream] 📡 Checking historical top-up up to ${initialNow.toISOString()}...`);
    process.env.SEED_DEMO_ENABLED = 'true';
    const { written, trimmed } = await topUpDemo(ds, { now: initialNow });
    const totalTopUp = Object.values(written).reduce((a, b) => a + b, 0);
    if (totalTopUp > 0) {
      console.log(`[SeedStream] 📡 Caught up ${totalTopUp} historical readings (trimmed ${trimmed} old rows).`);
    }

    // 2. Initial simultaneous tick
    const firstTick = await emitSimultaneousTick(ds, initialNow, includeQuiet);
    console.log(`[SeedStream] ⚡ Initial simultaneous emission: ${firstTick.count} readings across [${firstTick.machines.join(', ')}]`);

    // 3. Initial forecast and recommendation pass (background, non-blocking)
    runForecastAndRecommendations(ds, initialNow, true).catch((err) => {
      console.warn('[SeedStream] Background forecast notice:', err?.message || err);
    });

    if (once) {
      console.log(`[SeedStream] ✅ Completed execution (--once). Exiting.`);
      return;
    }

    console.log(`\n======================================================================`);
    console.log(`🚀 Live 30-Second Simultaneous Telemetry Streaming Active!`);
    console.log(`   - Emission Cadence: Every ${telemetryIntervalMs / 1000} seconds simultaneously`);
    console.log(`   - Equipment Fleet:  EX-01, EX-02, EX-03, EX-05, EX-06 (EX-04: quiet/dark)`);
    console.log(`   - Signals Emitted:  6 per machine (30 telemetry points per tick)`);
    console.log(`   - Forecast Cadence: Every ${(forecastIntervalMs / (3600 * 1000)).toFixed(1)} hours`);
    console.log(`   - Press Ctrl+C to terminate anytime.`);
    console.log(`======================================================================\n`);

    let lastForecastTime = initialNow.getTime();
    let tickCount = 0;

    for (;;) {
      // Align to exact telemetry interval boundary (e.g. :00 and :30)
      const nowMs = Date.now();
      const nextTickMs = (Math.floor(nowMs / telemetryIntervalMs) + 1) * telemetryIntervalMs;
      const sleepMs = Math.max(500, nextTickMs - nowMs);
      await new Promise((resolve) => setTimeout(resolve, sleepMs));

      const tickNow = new Date();
      tickCount++;

      try {
        const { count, machines } = await emitSimultaneousTick(ds, tickNow, includeQuiet);
        console.log(`[SeedStream] ⚡ [${tickNow.toISOString()}] Simultaneous emission: ${count} readings (${machines.join(', ')}). Link health updated.`);

        // Score predictions across active equipment every 60s (every 2 ticks) in background without blocking telemetry emission
        if (tickCount % 2 === 0) {
          const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
          const predictionService = new PredictionService(ds);
          (async () => {
            for (const m of fleet) {
              try {
                await predictionService.scoreAsset(adminScope, { sourceSystem: m.sourceSystem, externalId: m.externalId }, tickNow);
              } catch {}
            }
          })().catch(() => {});
        }

        // Periodically run forecast & recommendations (every 10 minutes, background)
        if (tickNow.getTime() - lastForecastTime >= forecastIntervalMs) {
          lastForecastTime = tickNow.getTime();
          runForecastAndRecommendations(ds, tickNow, true).catch((err) => {
            console.warn('[SeedStream] Periodic forecast notice:', err?.message || err);
          });
        }
      } catch (err: any) {
        console.error(`[SeedStream] ❌ Error during tick at ${tickNow.toISOString()}:`, err?.message || err);
      }
    }
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[SeedStream] Fatal error:', err);
    process.exit(1);
  });
}
