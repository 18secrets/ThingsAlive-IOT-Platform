import { DataSource } from 'typeorm';
import { ScenarioDefinition } from '../src/catalog/entities/scenario-definition.entity';
import { ScenarioRuleController } from '../src/catalog/scenario-rule.controller';
import { DEFAULT_WINDOW_DAYS } from '../src/prediction/services/baseline.service';
import { scenarioNumber } from '../src/prediction/services/scenario-params';
import { scenarioRule } from '../src/prediction/services/scenario-rule';
import { DEFAULT_CRITICAL_SIGMA, DEFAULT_MINIMUM_SAMPLES, DEFAULT_WARNING_SIGMA, scoreTier1 } from '../src/prediction/services/tier1';
import { createTestDataSource, describeDb } from './db';

/**
 * Fuel test report, 3 Nov 2026 — FU-1 / TC-FP-01: "Scenario rule logic 'evaluated
 * server-side (not shown here)'; no formula, threshold or rate in the library to validate."
 *
 * Retest criterion: the scenario view in Master Admin shows the rule and its inputs. These
 * hold the rule shown to the numbers the scorer applies — read by the same function — so
 * what Master Admin validates is what runs.
 */
const FUEL_BURN = {
  // As `scripts/seed-demo-scenarios.ts` defines demo-excavator-fuel-burn.
  requiredSignals: ['fuel_level', 'engine_load'],
  minimumHistoryDays: 7,
  parameters: [
    { key: 'warning_sigma', label: 'Warning threshold', type: 'number' as const, default: 2.0, unit: 'σ' },
    { key: 'critical_sigma', label: 'Critical threshold', type: 'number' as const, default: 3.0, unit: 'σ' },
  ],
};

describe('a scenario\'s rule, in the numbers the scorer uses', () => {
  it('Excessive Fuel Consumption Rate: both signals, its own 2σ and 3σ, and the scorer\'s 30-day window and sample floor', () => {
    const r = scenarioRule(FUEL_BURN);
    expect(r).toMatchObject({
      method: 'tier1@1', requiredSignals: ['fuel_level', 'engine_load'], minimumHistoryDays: 7, influence: null,
      baseline: { windowDays: DEFAULT_WINDOW_DAYS, warningSigma: 2, criticalSigma: 3, minimumSamples: DEFAULT_MINIMUM_SAMPLES },
    });
    expect(r.baseline.sentence).toContain('fuel_level, engine_load');
    expect(r.baseline.sentence).toContain('2 standard deviations away is a warning, 3 critical');
  });

  it('a scenario that declares nothing gets the scorer\'s own defaults, said as numbers', () => {
    expect(scenarioRule({ requiredSignals: ['coolant_temp'], minimumHistoryDays: 0, parameters: [] }).baseline).toMatchObject({
      warningSigma: DEFAULT_WARNING_SIGMA, criticalSigma: DEFAULT_CRITICAL_SIGMA, windowDays: DEFAULT_WINDOW_DAYS,
    });
  });

  it('the thresholds shown are the ones the scorer judges by: a reading 2.5σ out is a warning under this rule, not critical', () => {
    const rule = scenarioRule(FUEL_BURN);
    // A baseline of 50 ± 4 over plenty of operating samples; 60 is 2.5σ out.
    const outcome = scoreTier1({
      requiredSignals: ['fuel_level'],
      observations: [{ signal: 'fuel_level', value: 60, at: new Date('2026-11-03T10:00:00Z'), operating: true }],
      baselines: [{ signal: 'fuel_level', mean: 50, stddev: 4, sampleCount: 500 }],
      warningSigma: scenarioNumber(FUEL_BURN.parameters, null, 'warning_sigma', DEFAULT_WARNING_SIGMA),
      criticalSigma: scenarioNumber(FUEL_BURN.parameters, null, 'critical_sigma', DEFAULT_CRITICAL_SIGMA),
    });
    expect([rule.baseline.warningSigma, rule.baseline.criticalSigma]).toEqual([2, 3]);
    expect(outcome.signals[0]).toMatchObject({ signal: 'fuel_level' });
    expect(outcome.abnormalCount).toBe(1);
    expect(outcome.highPriority).toBe(false);
  });

  it('a scenario with an influence model is scored by it first, and its formula is written out', () => {
    const r = scenarioRule({
      requiredSignals: ['oil_temperature', 'engine_load'], minimumHistoryDays: 0,
      parameters: [{
        key: 'influence_model', default: {
          target: 'oil_temperature', intercept: 40, terms: [{ signal: 'engine_load', coefficient: 0.5 }],
          warnAbove: 8, criticalAbove: 15,
        },
      }],
    });
    expect(r.method).toBe('influence@1');
    expect(r.influence).toMatchObject({
      target: 'oil_temperature', warnAbove: 8, criticalAbove: 15, windowHours: 12,
      formula: 'expected oil_temperature = 40 + 0.5 × engine_load',
    });
    // The baseline is still there: it is the fallback when the window cannot answer.
    expect(r.baseline.warningSigma).toBe(DEFAULT_WARNING_SIGMA);
  });
});

describeDb('the Master Admin route reads a stored scenario version (FU-1)', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
  }, 60_000);

  afterAll(async () => { await owner?.destroy(); });

  it('a published fuel scenario\'s rule, by its id; an unknown id is not found', async () => {
    await owner.query(`INSERT INTO "equipment_class_profile" ("slug", "version", "name", "status", "expected_signals")
      VALUES ('demo-excavator', 1, 'Excavator', 'published', '[]'::jsonb)`);
    const saved = await owner.getRepository(ScenarioDefinition).save({
      slug: 'demo-excavator-fuel-burn', version: 1, equipmentClassSlug: 'demo-excavator', name: 'Excessive Fuel Consumption Rate',
      description: null, tier: 1, status: 'published', publishedAt: new Date(), ...FUEL_BURN,
    } as Partial<ScenarioDefinition>);
    const controller = new ScenarioRuleController(owner.getRepository(ScenarioDefinition));
    expect(await controller.rule(saved.id)).toMatchObject({
      slug: 'demo-excavator-fuel-burn', version: 1, method: 'tier1@1',
      requiredSignals: ['fuel_level', 'engine_load'], baseline: { warningSigma: 2, criticalSigma: 3 },
    });
    await expect(controller.rule('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/No such scenario version/);
  });
});
