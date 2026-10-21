import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { join } from 'path';
import { existsSync } from 'fs';
import { dataSourceOptions } from '../src/database/data-source';
import { DEMO_CLASS, DEMO_SOURCE, DEMO_TENANT, seedDemo, topUpDemo } from '../src/database/seeds/seed-demo';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ForecastService } from '../src/forecast/forecast.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';
import { RecFrameService } from '../src/rec-frame/rec-frame.service';

/**
 * Parse an interval string like '2h', '120m', '7200s' into milliseconds.
 * Defaults to 2 hours (2 * 3600 * 1000 ms).
 */
export function parseIntervalMs(raw?: string): number {
  if (!raw) return 2 * 60 * 60 * 1000;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(h|m|s|ms)?$/i);
  if (!match) return 2 * 60 * 60 * 1000;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'h').toLowerCase();
  switch (unit) {
    case 'h': return Math.round(num * 3600 * 1000);
    case 'm': return Math.round(num * 60 * 1000);
    case 's': return Math.round(num * 1000);
    case 'ms': return Math.round(num);
    default: return 2 * 60 * 60 * 1000;
  }
}

/**
 * Configure worker command for ForecastService.
 * If Python with infer.py is available, uses that; otherwise falls back to test stub worker.
 */
function resolveWorkerCommand() {
  const pythonPath = process.env.FORECAST_PYTHON || 'python3';
  const realScript = process.env.FORECAST_WORKER_SCRIPT || join(process.cwd(), 'python', 'forecast', 'infer.py');
  const stubScript = join(process.cwd(), 'test', 'forecast', 'stub-worker.js');

  // If real infer.py is requested and weights exist, use Python; otherwise use Node stub worker
  if (process.env.USE_REAL_WORKER === 'true' && existsSync(realScript)) {
    return { command: pythonPath, args: ['-I', realScript] };
  }
  return {
    command: process.execPath,
    args: [stubScript],
  };
}

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

  // 2. Enable forecasting on demo-excavator requirements
  await ds.query(`
    UPDATE equipment_class_sensor_requirement
       SET forecast_enabled = true,
           forecast_horizon_hours = 24
     WHERE class_slug = $1
       AND measurement_role IN ('engine_coolant_temperature', 'engine_oil_pressure')
  `, [DEMO_CLASS]);

  // 3. Ensure forecast_chart widget exists on the demo layout
  const [{ count }] = await ds.query(`
    SELECT count(*)::int AS count
      FROM client_equipment_class_layout
     WHERE tenant_id = $1
       AND widget_type = 'forecast_chart'
  `, [DEMO_TENANT]);

  if (count === 0) {
    const [{ maxPos }] = await ds.query(`
      SELECT coalesce(max(position), 0)::int AS "maxPos"
        FROM client_equipment_class_layout
       WHERE tenant_id = $1
    `, [DEMO_TENANT]);

    await ds.query(`
      INSERT INTO client_equipment_class_layout
        (tenant_id, client_equipment_class_slug, widget_type, widget_key, bound_to, title, position, size, hidden, position_custom)
      VALUES
        ($1, $2, 'forecast_chart', 'coolant_forecast', 'engine_coolant_temperature', 'Coolant Temp 24h Forecast', $3, 'medium', false, false)
    `, [DEMO_TENANT, DEMO_CLASS, maxPos + 1]);
    console.log(`[SeedStream] Added forecast_chart widget to ${DEMO_TENANT} layout.`);
  }

  // 4. Ensure historical residuals exist so confidence intervals & forecast charts are established
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
}

/**
 * Runs one complete pass:
 * 1. Top-up telemetry readings up to the current wall-clock minute
 * 2. Run TTM forecasting & residual anomaly pass
 * 3. Evaluate alerts and AI recommendations
 */
async function runSinglePass(ds: DataSource, forceForecast = true) {
  const now = new Date();
  console.log(`\n============================================================`);
  console.log(`[SeedStream] Cycle started at ${now.toISOString()}`);
  console.log(`============================================================`);

  // 1. Top-up telemetry
  process.env.SEED_DEMO_ENABLED = 'true';
  const { written, trimmed } = await topUpDemo(ds, { now });
  const totalReadings = Object.values(written).reduce((a, b) => a + b, 0);
  console.log(`[SeedStream] 📡 Telemetry Top-Up: ${totalReadings} fresh readings across ${Object.keys(written).length} machines (trimmed ${trimmed} old rows).`);
  for (const [machine, count] of Object.entries(written)) {
    if (count > 0) console.log(`   - ${machine}: +${count} readings`);
  }

  // 2. Forecast Pass
  if (forceForecast) {
    // Reset generated_at and context_to so ForecastService treats all eligible series as owed
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
  console.log(`[SeedStream] 🔮 Prediction/Forecast Pass: ${forecastSummary.outcome.toUpperCase()}`);
  console.log(`   - Considered Signals: ${forecastSummary.considered}`);
  console.log(`   - Forecasts Generated: ${forecastSummary.forecast}`);
  console.log(`   - Skipped (stale/unbound): ${forecastSummary.skipped}`);

  // Fetch samples of latest forecast horizons
  const latestForecasts: { external_id: string; signal: string; horizon_points: number }[] = await ds.query(`
    SELECT external_id, signal, jsonb_array_length(horizon) AS horizon_points
      FROM forecast_latest
     WHERE tenant_id = $1
     ORDER BY external_id, signal
     LIMIT 4
  `, [DEMO_TENANT]);

  if (latestForecasts.length > 0) {
    console.log(`   - Active Predictions in Database:`);
    for (const f of latestForecasts) {
      console.log(`     * ${f.external_id} (${f.signal}): ${f.horizon_points} horizon steps ahead`);
    }
  }

  // 3. AI Recommendation Engine & Framing
  const recEngine = new RecEngineService(ds);
  const recFrame = new RecFrameService(ds, recEngine);
  const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };

  try {
    const ev = await recEngine.evaluate(adminScope, { sourceSystem: DEMO_SOURCE, externalId: 'EX-03' });
    const framed = await recFrame.render(adminScope, ev.bundle.id);
    console.log(`[SeedStream] 🤖 AI Recommendation Engine:`);
    console.log(`   - Target: EX-03 (High Coolant Alert)`);
    console.log(`   - Diagnosis: "${framed.answer.summary}"`);
    if (framed.answer.next_steps?.[0]?.aim) {
      console.log(`   - Action: "${framed.answer.next_steps[0].aim}"`);
    }
  } catch (err: any) {
    console.warn(`[SeedStream] Recommendation evaluation notice: ${err?.message || err}`);
  }

  console.log(`[SeedStream] Cycle completed at ${new Date().toISOString()}.\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  
  // Find interval from args (e.g., --interval 2h or -i 2h) or env REFRESH_INTERVAL
  let intervalArg: string | undefined;
  const intervalIdx = args.findIndex((a) => a === '--interval' || a === '-i');
  if (intervalIdx !== -1 && args[intervalIdx + 1]) {
    intervalArg = args[intervalIdx + 1];
  } else {
    intervalArg = process.env.REFRESH_INTERVAL || (process.env.REFRESH_INTERVAL_HOURS ? `${process.env.REFRESH_INTERVAL_HOURS}h` : '2h');
  }

  const intervalMs = parseIntervalMs(intervalArg);
  const intervalHours = (intervalMs / (3600 * 1000)).toFixed(2);

  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  console.log(`[SeedStream] 🔗 Connected to database (${process.env.DATABASE_URL ? 'Remote/Railway' : 'Local'})`);

  try {
    await ensurePrerequisites(ds);

    // Initial run
    await runSinglePass(ds, true);

    if (once) {
      console.log('[SeedStream] Completed one-time execution (--once). Exiting.');
      return;
    }

    const nextDate = new Date(Date.now() + intervalMs);
    console.log(`[SeedStream] ⏳ Live Telemetry & Prediction Scheduler active!`);
    console.log(`   - Refresh Interval: ${intervalArg} (${intervalHours} hours)`);
    console.log(`   - Next automatic cycle scheduled at: ${nextDate.toISOString()}`);
    console.log(`   - Press Ctrl+C to terminate anytime.\n`);

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        await runSinglePass(ds, true);
        const scheduledNext = new Date(Date.now() + intervalMs);
        console.log(`[SeedStream] Next automatic cycle scheduled at: ${scheduledNext.toISOString()}`);
      } catch (err: any) {
        console.error(`[SeedStream] Error during pass:`, err);
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
