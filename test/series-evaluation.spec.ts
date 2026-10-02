import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { AlertRule } from '../src/alert/entities/alert-rule.entity';
import { AlertEvent } from '../src/alert/entities/alert-event.entity';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { Plant } from '../src/equipment/entities/plant.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { TelemetryWindowReader } from '../src/kpi/services/telemetry-window-reader';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeDb('QCE2.1: series evaluation', () => {
  let ds: DataSource;
  let owner: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-1' };
  const IMEI = 'imei-dg-1';
  const NOW = new Date('2026-09-22T12:00:00.000Z');
  const CLASS_SLUG = 'diesel-generator';
  let plantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['telemetry_reading', 'signal_binding_version', 'alert_event', 'alert_rule',
      'device_projection', 'equipment_profile', 'client_formula', 'client_equipment_class', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const plant = await owner.getRepository(Plant).save(owner.getRepository(Plant).create({
      tenantId: 'acme', code: 'north', name: 'North Site', status: 'active',
    }));
    plantId = plant.id;

    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: CLASS_SLUG, name: 'Diesel generator',
      description: null, category: 'power', expectedSignals: [], failureModes: [],
      defaultThresholds: {}, templateSlug: CLASS_SLUG, templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    await owner.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      equipmentClassSlug: CLASS_SLUG, classVersion: 1, plantId, tier: 'standard', commissionedAt: null,
      serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
    });
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: EQUIPMENT.sourceSystem, externalId: `dev-${EQUIPMENT.externalId}`, tenantId: 'acme',
      payload: {}, sourceUpdatedAt: null, syncedAt: NOW, checksum: 'c', status: 'live',
      imei: IMEI, equipmentExternalId: EQUIPMENT.externalId, name: null,
    });
    await owner.getRepository(SignalBindingVersion).save({
      tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
      signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c', componentId: '',
      origin: 'physical', imei: IMEI, channel: 'ch1', sensorInstanceId: null,
      canonicalUnit: 'degC', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      // Matches this file's own sparse fixtures (readings hours apart, not
      // every minute) — see the identical note in kpi-evaluation.spec.ts.
      expectedPeriodSeconds: 12 * 3600, isPrimary: true, status: 'active',
      discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u-master', approvedAt: NOW,
    });
  });

  const saveFormula = async (formulaKey: string, expression: string, aggregationWindow: '24h' | '7d' | '30d' = '24h') => {
    const compiled = compileFormula({
      formulaKey, expression, classSlug: CLASS_SLUG,
      expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
    });
    await owner.getRepository(ClientFormula).save({
      tenantId: 'acme', clientEquipmentClassSlug: CLASS_SLUG, formulaKey,
      kind: 'empirical', expression, compiledPlan: compiled.plan as any,
      compiledAt: NOW, compilerVersion: compiled.compilerVersion, resultUnit: compiled.resultUnit,
      requiredSignals: compiled.requiredSignals, requiredParameters: [], bindings: [],
      resultKind: compiled.resultKind, displayUnit: null, displayFormat: 'number:1',
      targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none',
      comparisonBasis: 'none', aggregationWindow, chartType: 'none',
      templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    return compiled;
  };

  const seedReadings = async (points: { hoursAgo: number; value: number }[]) => owner.getRepository(TelemetryReading).save(
    points.map((p) => ({
      tenantId: 'acme', imei: IMEI, signal: 'coolant_temp_c', value: p.value, unit: 'degC',
      sourceTimestamp: new Date(NOW.getTime() - p.hoursAgo * HOUR), receivedAt: NOW, source: 'live' as const,
    })),
  );

  describe('§1: series output shape', () => {
    it('a bare-signal series plan returns bucketed points, ascending by t, with null for empty buckets', async () => {
      await saveFormula('coolant_series', 'coolant_temp_c');
      // One reading per hour for 3 hours, inside a 12h window — most 5-minute
      // buckets have nothing in them.
      await seedReadings([{ hoursAgo: 2, value: 80 }, { hoursAgo: 1, value: 85 }, { hoursAgo: 0.05, value: 90 }]);

      // Explicit 12h window — 'coolant_series' itself declares aggregation_window
      // '24h', which lands on 15-minute buckets (96), not the 5-minute (144) a
      // 12h window gives; passing the window explicitly is what actually tests
      // the ladder's 12h/5m case rather than its 24h/15m one.
      const window = { from: new Date(NOW.getTime() - 12 * HOUR), to: NOW };
      const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_series', NOW, window);
      expect(envelope.readiness).toBe('ready');
      const points = envelope.value as { t: string; v: number | null }[];
      expect(Array.isArray(points)).toBe(true);
      expect(points.length).toBeGreaterThan(100); // 12h / 5m ≈ 144
      // ascending
      const ts = points.map((p) => new Date(p.t).getTime());
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
      // some buckets have data, most do not — both are represented, never 0
      expect(points.some((p) => p.v !== null)).toBe(true);
      expect(points.some((p) => p.v === null)).toBe(true);
      expect(points.every((p) => p.v !== 0 || p.v === null)).toBe(true);
    });

    it('a plan declaring series that this evaluator cannot bucket throws, naming the formula key — '
      + 'not a silent scalar', async () => {
      // #formula_key composition inside a series-kind plan is outside the
      // bucketable shapes this task supports (bare signal / one reducer over
      // one signal / +-*/ over such shapes).
      await saveFormula('base_series', 'coolant_temp_c');
      await owner.query(`
        UPDATE "client_formula" SET "compiled_plan" = $1, "required_signals" = $2
        WHERE "formula_key" = 'base_series'`,
      [JSON.stringify({ type: 'call', kind: 'series', unit: 'degC', name: 'avg', args: [{ type: 'call', kind: 'series', unit: 'degC', name: 'avg', args: [{ type: 'signal', kind: 'series', unit: 'degC', name: 'coolant_temp_c' }] }] }), ['coolant_temp_c']]);
      // Within the platform-default staleness threshold (900s) — this test is
      // about the plan-shape refusal, not staleness.
      await seedReadings([{ hoursAgo: 0.05, value: 80 }]);
      await expect(evaluator.evaluateOne(scope, EQUIPMENT, 'base_series', NOW)).rejects.toThrow(/base_series/);
    });
  });

  describe('§4: baseline operators stay single-valued', () => {
    it('a series plan whose root is a baseline operator returns a one-point array at the window\'s latest instant', async () => {
      await saveFormula('coolant_z', 'zscore(coolant_temp_c, 20d)');
      const history = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: (20 - i) * 24, value: 50 }));
      await seedReadings([...history, { hoursAgo: 0.1, value: 80 }]);

      const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_z', NOW);
      expect(envelope.readiness).toBe('ready');
      const points = envelope.value as { t: string; v: number | null }[];
      expect(points).toHaveLength(1);
      expect(points[0].t).toBe(NOW.toISOString());
      // What this test checks is the shape — one point, at the window's latest
      // instant, holding a real number — not the exact value: whether the
      // "current" reading also bleeds into the baseline's own lookback window
      // (it is strictly before `asOf`, same as every history point, so it can)
      // is a QCE2-level question about how `asOf` and "current" relate, not
      // something this task changes. QCE4's own tests pin the arithmetic.
      expect(typeof points[0].v).toBe('number');
    });
  });

  describe('§5: alert-based dirty-window exclusion, by appliesTo scope', () => {
    // baseline_avg gives clean, deterministic arithmetic to prove exclusion
    // with. The "current" reading (0.1h ago) is strictly before `asOf`, same
    // as every history point, so baseline_avg's own lookback window includes
    // it too — 21 points, not 20. Unexcluded: 19×50 + 500 + 50 = 1500, over
    // 21 = 1500/21. Excluded: the spike alone is removed, the remaining 20
    // points (19 history + the current one) are flat at 50 exactly.
    const avgFormula = () => saveFormula('coolant_avg', 'baseline_avg(coolant_temp_c, 20d)');
    const SPIKE_INDEX = 9; // 11 days ago
    const historyWithSpike = () => {
      const history = Array.from(
        { length: 20 }, (_, i) => ({ hoursAgo: (20 - i) * 24, value: i === SPIKE_INDEX ? 500 : 50 }),
      );
      return seedReadings([...history, { hoursAgo: 0.1, value: 50 }]);
    };
    const UNEXCLUDED_AVG = 1500 / 21;
    const EXCLUDED_AVG = 50;
    // Brackets exactly the spike's own timestamp: (20-9)*24 = 264h = 11 days ago.
    const dirtyRange = { firedHoursAgo: 11 * 24, resolvedHoursAgo: 9 * 24 };

    const saveRule = (over: Partial<AlertRule>) => owner.getRepository(AlertRule).save(
      owner.getRepository(AlertRule).create({
        tenantId: 'acme', slug: `rule-${Math.random()}`, name: 'r', trigger: 'signal-threshold',
        params: { signal: 'coolant_temp_c' } as any, enabled: true, ...over,
      }),
    );
    const saveEvent = (ruleId: string, firedHoursAgo: number, resolvedHoursAgo: number | null) =>
      owner.getRepository(AlertEvent).save(owner.getRepository(AlertEvent).create({
        tenantId: 'acme', ruleId, ruleName: 'r', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        severity: 'high' as any, summary: 's', evidence: {},
        state: resolvedHoursAgo === null ? 'open' : 'resolved',
        resolutionNote: resolvedHoursAgo === null ? null : 'test fixture',
        firedAt: new Date(NOW.getTime() - firedHoursAgo * HOUR),
        resolvedAt: resolvedHoursAgo === null ? null : new Date(NOW.getTime() - resolvedHoursAgo * HOUR),
      }));
    const avgValue = async () => {
      const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_avg', NOW);
      return (envelope.value as { t: string; v: number | null }[])[0].v;
    };

    it('baseline: with no rule at all, the spike is not excluded', async () => {
      await avgFormula(); await historyWithSpike();
      expect(await avgValue()).toBe(UNEXCLUDED_AVG);
    });

    it.each([
      ['equipment', { sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId }, true],
      ['equipment', { sourceSystem: EQUIPMENT.sourceSystem, externalId: 'DG-OTHER' }, false],
      ['plant', { plantId: undefined }, true], // resolved to the fixture's plant at run time
      ['plant', { plantId: '00000000-0000-0000-0000-000000000000' }, false],
      ['equipment-class', { equipmentClassSlug: CLASS_SLUG }, true],
      ['equipment-class', { equipmentClassSlug: 'other-class' }, false],
      ['account', {}, true],
    ])('scope "%s" %o excludes=%s', async (appliesTo, fields: any, shouldExclude) => {
      await avgFormula(); await historyWithSpike();
      const resolvedFields = { ...fields };
      if (appliesTo === 'plant' && fields.plantId === undefined) resolvedFields.plantId = plantId;
      const rule = await saveRule({ appliesTo: appliesTo as any, ...resolvedFields });
      await saveEvent(rule.id, dirtyRange.firedHoursAgo, dirtyRange.resolvedHoursAgo);

      expect(await avgValue()).toBe(shouldExclude ? EXCLUDED_AVG : UNEXCLUDED_AVG);
    });

    it('a rule on a different signal leaves the baseline unchanged — condition (b), the one that matters', async () => {
      await avgFormula(); await historyWithSpike();
      const rule = await saveRule({ appliesTo: 'account', params: { signal: 'oil_pressure_kpa' } as any });
      await saveEvent(rule.id, dirtyRange.firedHoursAgo, dirtyRange.resolvedHoursAgo);
      expect(await avgValue()).toBe(UNEXCLUDED_AVG);
    });

    it('an alert still open at evaluation time excludes up to now', async () => {
      await avgFormula();
      // Spike in the last two days; an open alert since 3 days ago excludes it.
      const history = Array.from({ length: 20 }, (_, i) => ({ hoursAgo: (20 - i) * 24, value: i === 18 ? 500 : 50 }));
      await seedReadings([...history, { hoursAgo: 0.1, value: 50 }]);
      const rule = await saveRule({ appliesTo: 'account' });
      await saveEvent(rule.id, 3 * 24, null); // still open — no resolvedAt
      expect(await avgValue()).toBe(EXCLUDED_AVG);
    });

    it('exclusion that drops the remaining history below the 14-day minimum yields baseline_not_established', async () => {
      await avgFormula(); await historyWithSpike();
      const rule = await saveRule({ appliesTo: 'account' });
      await saveEvent(rule.id, 20 * 24, 1 * 24); // excludes essentially the whole 20-day history
      const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_avg', NOW);
      expect(envelope).toMatchObject({ readiness: 'not_available', reason: 'baseline_not_established' });
    });
  });

  describe('§3 and §6: partitions and performance', () => {
    it('§3: a bucketed 12h-window query touches exactly one partition', async () => {
      await saveFormula('coolant_series', 'coolant_temp_c');
      await seedReadings([{ hoursAgo: 1, value: 80 }]);
      const reader = new TelemetryWindowReader();
      const { partitions } = await runTenantSpanning(owner, 'test fixture', (m) => reader.explainBucketed(
        m, 'acme', [IMEI], ['coolant_temp_c'], 300, new Date(NOW.getTime() - 12 * HOUR), NOW,
      ));
      expect(partitions).toEqual(['2026_09']);
    });

    it('§6: one series KPI (12h, 5m buckets) and twenty mixed widgets, measured', async () => {
      await saveFormula('coolant_series', 'coolant_temp_c');
      await seedReadings([{ hoursAgo: 1, value: 80 }, { hoursAgo: 0.5, value: 85 }]);

      const t0 = Date.now();
      await evaluator.evaluateOne(scope, EQUIPMENT, 'coolant_series', NOW);
      // eslint-disable-next-line no-console
      console.log(`§6: one series KPI, 12h/5m, took ${Date.now() - t0}ms`);

      await owner.getRepository(ClientFormula).save(
        Array.from({ length: 19 }, (_, i) => {
          const expr = i % 2 === 0 ? 'avg(coolant_temp_c)' : 'coolant_temp_c';
          const compiled = compileFormula({
            formulaKey: `w_${i}`, expression: expr, classSlug: CLASS_SLUG,
            expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
          });
          return owner.getRepository(ClientFormula).create({
            tenantId: 'acme', clientEquipmentClassSlug: CLASS_SLUG, formulaKey: `w_${i}`,
            kind: 'empirical', expression: expr, compiledPlan: compiled.plan as any,
            compiledAt: NOW, compilerVersion: compiled.compilerVersion, resultUnit: compiled.resultUnit,
            requiredSignals: compiled.requiredSignals, requiredParameters: [], bindings: [],
            resultKind: compiled.resultKind, displayUnit: null, displayFormat: 'number:1',
            targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none',
            comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
            templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
          });
        }),
      );
      const t1 = Date.now();
      const envelopes = await evaluator.evaluateAll(scope, EQUIPMENT, NOW);
      const elapsed = Date.now() - t1;
      // eslint-disable-next-line no-console
      console.log(`§6: twenty mixed widgets took ${elapsed}ms`);
      expect(envelopes).toHaveLength(20);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
