import 'reflect-metadata';
process.env.DEMO_FORCE_RUNNING = 'true';
process.env.SEED_DEMO_ENABLED = 'true';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { existsSync } from 'fs';
import { dataSourceOptions } from '../src/database/data-source';
import {
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
  const scenarios = ['coolant-drift', 'hydraulic-heat'];
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

    const demoMachines = ['EX-01', 'EX-02', 'EX-03', 'EX-05', 'EX-06'];
    const demoSignals = ['engine_coolant_temperature', 'engine_oil_pressure'];

    for (const machine of demoMachines) {
      for (const signal of demoSignals) {
        const [{ count: daysCount }] = await ds.query(
          `SELECT count(DISTINCT (step_at at time zone 'UTC')::date)::int AS count
             FROM forecast_residual
            WHERE tenant_id = $1 AND external_id = $2 AND signal = $3 AND model_id = $4`,
          [DEMO_TENANT, machine, signal, modelId]
        );

        if (daysCount < 30) {
          const now = Date.now();
          const DAY_MS = 24 * 3600 * 1000;
          const HOUR_MS = 3600 * 1000;
          const rowsToInsert = [];

          for (let d = 40; d >= 1; d--) {
            const dayBase = Math.floor((now - d * DAY_MS) / DAY_MS) * DAY_MS + 10 * HOUR_MS;
            const predBase = signal === 'engine_coolant_temperature' ? 65.0 : 380.0;
            const noise = parseFloat((Math.sin(d + (machine === 'EX-03' ? 2 : 0)) * 0.8).toFixed(4));
            const actual = predBase + noise;
            const res = actual - predBase;

            rowsToInsert.push({
              tenant_id: DEMO_TENANT,
              source_system: DEMO_SOURCE,
              external_id: machine,
              signal,
              model_id: modelId,
              run_id: runId,
              step_at: new Date(dayBase),
              lead_steps: 1,
              predicted: predBase,
              actual,
              residual: res,
              operating: true,
            });
          }

          if (rowsToInsert.length > 0) {
            await ds.createQueryBuilder()
              .insert()
              .into('forecast_residual')
              .values(rowsToInsert)
              .orIgnore()
              .execute();
          }
        }
      }
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
}

/**
 * Emits simultaneous telemetry for all active demo equipment at exact timestamp `now`.
 * All signals for all active machines are generated in parallel and bulk-inserted in a single query.
 */
export async function emitSimultaneousTick(ds: DataSource, now: Date, includeQuiet = false): Promise<{ count: number; machines: string[] }> {
  const nowMs = now.getTime();
  const tickStep = 30 * 1000;
  const tickIndex = Math.floor(nowMs / tickStep);

  const activeMachines = DEMO_MACHINES.filter((m) => m.endDaysAgo === 0 || includeQuiet);

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
    const imei = imeiOf(machine);
    for (const [index, s] of DEMO_SIGNALS.entries()) {
      let val: number;
      if (machine.state === 'breaching' && s.signal === 'engine_coolant_temperature' && running(nowMs)) {
        val = BREACH_TAIL[tickIndex % BREACH_TAIL.length];
      } else {
        const noise = prng(Number(machine.externalId.slice(-2)) * 101 + index + tickIndex * 7919);
        val = demoValue(machine, s.signal, nowMs, nowMs, noise);
      }

      imeis.push(imei);
      signals.push(s.signal);
      values.push(parseFloat(val.toFixed(2)));
      units.push(s.unit);
    }

    // Fuel consumption (rate in L/h) for productive quality tracking in OEE
    const noiseFuel = prng(Number(machine.externalId.slice(-2)) * 313 + tickIndex * 6271)();
    const isEngineRunning = running(nowMs);
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
  const demoImeis = [
    { imei: '358000000000100', id: 'EX-01', state: 'healthy' },
    { imei: '358000000000200', id: 'EX-02', state: 'healthy' },
    { imei: '358000000000300', id: 'EX-03', state: 'healthy' },
    { imei: '358000000000400', id: 'EX-04', state: includeQuiet ? 'healthy' : 'dark' },
    { imei: '358000000000500', id: 'EX-05', state: 'healthy' },
    { imei: '358000000000600', id: 'EX-06', state: 'healthy' },
  ];

  for (const m of demoImeis) {
    const isOnline = m.state === 'healthy';
    await ds.query(`
      INSERT INTO device_link_health (
        tenant_id, imei, source_system, external_id, local_date,
        window_start, window_end, state, detail, reported_signals, missing_signals, samples, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT ("tenant_id", "imei", "window_start") DO UPDATE
        SET window_end = EXCLUDED.window_end, state = EXCLUDED.state, detail = EXCLUDED.detail, computed_at = EXCLUDED.computed_at
    `, [
      DEMO_TENANT, m.imei, DEMO_SOURCE, m.id, now.toISOString().slice(0, 10),
      windowStart, now, m.state, isOnline ? 'Healthy link (live streaming)' : 'No readings received (offline)',
      isOnline ? ['engine_coolant_temperature', 'engine_oil_pressure', 'engine_speed', 'hydraulic_oil_temperature', 'fuel_level', 'engine_running_status'] : [],
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
  const demoMachines = ['EX-01', 'EX-02', 'EX-03', 'EX-04', 'EX-05', 'EX-06'];
  const [{ count: baselineCount }] = await ds.query(
    `SELECT count(*)::int AS count FROM prediction_baseline WHERE tenant_id = $1`, [DEMO_TENANT]
  );
  if (baselineCount === 0) {
    const baselineService = new BaselineService(ds);
    for (const machine of demoMachines) {
      try {
        await baselineService.refresh(adminScope, { sourceSystem: DEMO_SOURCE, externalId: machine });
      } catch {}
    }
  }

  const predictionService = new PredictionService(ds);
  let scoredCount = 0;
  for (const machine of demoMachines) {
    try {
      const res = await predictionService.scoreAsset(adminScope, { sourceSystem: DEMO_SOURCE, externalId: machine }, now);
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

    // 3. Initial forecast and recommendation pass
    await runForecastAndRecommendations(ds, initialNow, true);

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

        // Score predictions across active equipment every 60s (every 2 ticks)
        if (tickCount % 2 === 0) {
          const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
          const predictionService = new PredictionService(ds);
          for (const m of DEMO_MACHINES) {
            try {
              await predictionService.scoreAsset(adminScope, { sourceSystem: DEMO_SOURCE, externalId: m.externalId }, tickNow);
            } catch {}
          }
        }

        // Periodically run forecast & recommendations (every 10 minutes)
        if (tickNow.getTime() - lastForecastTime >= forecastIntervalMs) {
          lastForecastTime = tickNow.getTime();
          await runForecastAndRecommendations(ds, tickNow, true);
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
