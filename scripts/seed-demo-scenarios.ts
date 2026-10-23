import 'reflect-metadata';
process.env.DEMO_FORCE_RUNNING = 'true';
process.env.SEED_DEMO_ENABLED = 'true';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import {
  DEMO_CLASS,
  DEMO_MACHINES,
  DEMO_SOURCE,
  DEMO_TENANT,
} from '../src/database/seeds/seed-demo';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { emitSimultaneousTick } from './stream-demo-telemetry';

interface ScenarioSpec {
  slug: string;
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tier: number;
  requiredSignals: string[];
  minimumHistoryDays: number;
  parameters: any[];
}

const DEMO_SCENARIO_SPECS: ScenarioSpec[] = [
  {
    slug: 'demo-excavator-coolant-drift',
    name: 'Coolant Thermal Runaway Drift',
    description: 'Detects progressive thermal creep in the cooling jacket leading to cylinder head overheating.',
    severity: 'high',
    tier: 1,
    requiredSignals: ['engine_coolant_temperature'],
    minimumHistoryDays: 7,
    parameters: [
      { key: 'warning_sigma', label: 'Warning threshold', type: 'number', default: 1.8, unit: 'σ' },
      { key: 'critical_sigma', label: 'Critical threshold', type: 'number', default: 2.5, unit: 'σ' },
    ],
  },
  {
    slug: 'demo-excavator-hydraulic-heat',
    name: 'Hydraulic Circuit Heat Soak',
    description: 'Forecasts hydraulic fluid viscosity breakdown and pump cavitational stress under continuous duty.',
    severity: 'medium',
    tier: 1,
    requiredSignals: ['hydraulic_oil_temperature', 'engine_load'],
    minimumHistoryDays: 7,
    parameters: [
      { key: 'warning_sigma', label: 'Warning threshold', type: 'number', default: 2.0, unit: 'σ' },
      { key: 'critical_sigma', label: 'Critical threshold', type: 'number', default: 3.0, unit: 'σ' },
    ],
  },
  {
    slug: 'demo-excavator-oil-pressure',
    name: 'Engine Lubrication & Low Oil Pressure',
    description: 'Predicts imminent bearing wipe and catastrophic seizure when lubrication pressure sags under load.',
    severity: 'critical',
    tier: 1,
    requiredSignals: ['engine_oil_pressure'],
    minimumHistoryDays: 7,
    parameters: [
      { key: 'warning_sigma', label: 'Warning threshold', type: 'number', default: 2.0, unit: 'σ' },
      { key: 'critical_sigma', label: 'Critical threshold', type: 'number', default: 3.0, unit: 'σ' },
    ],
  },
  {
    slug: 'demo-excavator-fuel-burn',
    name: 'Excessive Fuel Consumption Rate',
    description: 'Identifies injector nozzle fouling, valve leakback, or abnormal fuel burn relative to load factor.',
    severity: 'medium',
    tier: 1,
    requiredSignals: ['fuel_level', 'engine_load'],
    minimumHistoryDays: 7,
    parameters: [
      { key: 'warning_sigma', label: 'Warning threshold', type: 'number', default: 2.0, unit: 'σ' },
      { key: 'critical_sigma', label: 'Critical threshold', type: 'number', default: 3.0, unit: 'σ' },
    ],
  },
  {
    slug: 'demo-excavator-engine-stress',
    name: 'High Engine Stress & Duty Fatigue',
    description: 'Monitors cumulative mechanical fatigue and thermal saturation during prolonged high load cycles.',
    severity: 'high',
    tier: 1,
    requiredSignals: ['engine_load', 'engine_coolant_temperature'],
    minimumHistoryDays: 7,
    parameters: [
      { key: 'warning_sigma', label: 'Warning threshold', type: 'number', default: 2.0, unit: 'σ' },
      { key: 'critical_sigma', label: 'Critical threshold', type: 'number', default: 3.0, unit: 'σ' },
    ],
  },
];

export async function setupDemoScenarios(ds: DataSource) {
  const adminScope = { tenantId: DEMO_TENANT, userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const seederId = '00000000-0000-0000-0000-000000000001';

  console.log(`[Scenarios] Authoring ${DEMO_SCENARIO_SPECS.length} prediction scenarios...`);

  for (const s of DEMO_SCENARIO_SPECS) {
    // 1. Ensure scenario definition
    await ds.query(`
      INSERT INTO scenario_definition (
        slug, version, equipment_class_slug, name, description, severity, tier,
        required_signals, minimum_history_days, parameters, status, published_at, updated_at
      ) VALUES (
        $1, 1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'published', now(), now()
      )
      ON CONFLICT (slug, version) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            severity = EXCLUDED.severity,
            required_signals = EXCLUDED.required_signals,
            parameters = EXCLUDED.parameters,
            status = 'published',
            published_at = now(),
            updated_at = now()
    `, [
      s.slug, DEMO_CLASS, s.name, s.description, s.severity, s.tier,
      s.requiredSignals, s.minimumHistoryDays, JSON.stringify(s.parameters)
    ]);

    // 2. Ensure client scenario entitlement
    await ds.query(`
      INSERT INTO client_scenario (
        tenant_id, slug, client_equipment_class_slug, name, description, severity, tier,
        required_signals, minimum_history_days, parameters, enabled, status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, true, 'published', now(), now()
      )
      ON CONFLICT (tenant_id, slug) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            severity = EXCLUDED.severity,
            required_signals = EXCLUDED.required_signals,
            parameters = EXCLUDED.parameters,
            enabled = true,
            status = 'published',
            updated_at = now()
    `, [
      DEMO_TENANT, s.slug, DEMO_CLASS, s.name, s.description, s.severity, s.tier,
      s.requiredSignals, s.minimumHistoryDays, JSON.stringify(s.parameters)
    ]);

    // 3. Activate scenario on all demo machines
    for (const machine of DEMO_MACHINES) {
      await ds.query(`
        INSERT INTO equipment_scenario (
          tenant_id, source_system, external_id, client_scenario_slug, state, parameter_overrides, blockers_at_activation, activated_at, state_changed_at
        ) VALUES (
          $1, $2, $3, $4, 'active', '{}'::jsonb, '[]'::jsonb, now() - interval '14 days', now()
        )
        ON CONFLICT (tenant_id, source_system, external_id, client_scenario_slug) DO UPDATE
          SET state = 'active', state_changed_at = now()
      `, [DEMO_TENANT, DEMO_SOURCE, machine.externalId, s.slug]);
    }
  }

  // 4. Ensure partitions for prediction table
  await ds.query(`SELECT ta_ensure_prediction_partition(date_trunc('month', now())::date)`);
  await ds.query(`SELECT ta_ensure_prediction_partition((date_trunc('month', now()) - interval '1 month')::date)`);

  // 5. Ensure baselines are fresh
  const baselineService = new BaselineService(ds);
  for (const m of DEMO_MACHINES) {
    try {
      await baselineService.refresh(adminScope, { sourceSystem: DEMO_SOURCE, externalId: m.externalId });
    } catch {}
  }

  // 6. Emit operating tick and score all scenarios with real predictions for right now
  const now = new Date();
  await emitSimultaneousTick(ds, now);

  const predictionService = new PredictionService(ds);
  for (const m of DEMO_MACHINES) {
    try {
      await predictionService.scoreAsset(adminScope, { sourceSystem: DEMO_SOURCE, externalId: m.externalId }, now);
    } catch (e: any) {
      console.warn(`Scoring ${m.externalId} warning:`, e?.message || e);
    }
  }

  // 7. Generate rich historical prediction trend points over the last 10 days
  // This produces beautiful trend sparklines on ThingsCare and Live Predictions!
  console.log(`[Scenarios] Generating 10-day prediction history for sparklines and trends...`);
  const DAY_MS = 24 * 3600 * 1000;

  for (let dayOffset = 10; dayOffset >= 1; dayOffset--) {
    const historicalTime = new Date(now.getTime() - dayOffset * DAY_MS);

    for (const m of DEMO_MACHINES) {
      for (const s of DEMO_SCENARIO_SPECS) {
        let riskScore = 15;
        let severity: 'none' | 'low' | 'medium' | 'high' | 'critical' = 'none';
        let abnormalCount = 0;

        if (m.state === 'breaching') {
          // EX-03 escalates rapidly over the 10 days up to 96%
          const prog = (10 - dayOffset) / 9; // 0 to 1
          riskScore = Math.round(45 + prog * 51); // 45 -> 96
          if (riskScore >= 85) severity = 'critical';
          else if (riskScore >= 60) severity = 'high';
          else severity = 'medium';
          abnormalCount = riskScore >= 70 ? 2 : 1;
        } else if (m.state === 'trending') {
          // EX-02 drifts progressively over the 10 days up to 78%
          const prog = (10 - dayOffset) / 9; // 0 to 1
          if (s.slug === 'demo-excavator-coolant-drift' || s.slug === 'demo-excavator-engine-stress') {
            riskScore = Math.round(20 + prog * 58); // 20 -> 78
            severity = riskScore >= 60 ? 'high' : riskScore >= 40 ? 'medium' : 'low';
            abnormalCount = riskScore >= 60 ? 1 : 0;
          } else {
            riskScore = 22 + (dayOffset % 5);
            severity = 'none';
          }
        } else if (m.state === 'healthy') {
          // EX-01 stays stable, healthy, low risk
          riskScore = 14 + ((dayOffset * 7 + 3) % 8); // 14 -> 21
          severity = 'none';
          abnormalCount = 0;
        } else {
          // Others
          riskScore = 18 + (dayOffset % 6);
          severity = 'none';
        }

        const signals = s.requiredSignals.map((sig) => ({
          signal: sig,
          value: sig === 'engine_coolant_temperature' && m.state === 'breaching' ? 108 : 45,
          mean: 48.6,
          stddev: 22.7,
          z: severity === 'critical' ? 3.2 : severity === 'high' ? 2.1 : -0.3,
          state: severity === 'critical' ? 'critical' : severity === 'high' ? 'warning' : 'normal',
        }));

        await ds.query(`
          INSERT INTO prediction (
            tenant_id, source_system, external_id, client_scenario_slug, occurred_at,
            severity, risk_score, abnormal_count, high_priority, confidence,
            signals, window_days, model_ref, model_tier, source, computed_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, 'full',
            $10::jsonb, 30, 'tier1@1', 1, 'replayed', $5
          )
          ON CONFLICT (tenant_id, source_system, external_id, client_scenario_slug, occurred_at) DO UPDATE
            SET risk_score = EXCLUDED.risk_score, severity = EXCLUDED.severity
        `, [
          DEMO_TENANT, DEMO_SOURCE, m.externalId, s.slug, historicalTime,
          severity, riskScore, abnormalCount, severity === 'critical' || severity === 'high',
          JSON.stringify(signals)
        ]);
      }
    }
  }

  console.log(`[Scenarios] ✅ Setup complete. ${DEMO_SCENARIO_SPECS.length} scenarios active across demo fleet.`);
}

async function main() {
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  console.log(`[Scenarios] Connected to DB.`);
  try {
    await setupDemoScenarios(ds);
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
