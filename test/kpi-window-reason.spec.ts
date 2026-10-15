import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const DAY = 24 * 3_600_000;

/**
 * A KPI with no window, and one with no plan, say why (known issue, 2026-10-14).
 *
 * Asked without from/to, a formula whose own window cannot be resolved came back with
 * `window: { from: '', to: '' }` — two strings that are not dates, which a screen then
 * formats as "Invalid Date" — and `not_configured` with no reason, against the rule that
 * every non-ready state names why. The same KPI asked with a window answered normally,
 * so the missing piece was the window, and the envelope now says so.
 */
describeDb('KPI envelope: an unresolvable window or a missing plan names its reason', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-W' };
  const NOW = new Date('2026-09-22T12:00:00.000Z');

  const compiled = compileFormula({
    formulaKey: 'avg_coolant', expression: 'avg(coolant_temp_c)', classSlug: 'diesel-generator',
    expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
  });

  const formula = (formulaKey: string, aggregationWindow: string, plan: unknown) => ({
    tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey,
    kind: 'empirical', expression: 'avg(coolant_temp_c)',
    compiledPlan: plan as any, compiledAt: plan ? NOW : null, compilerVersion: plan ? compiled.compilerVersion : null,
    resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
    requiredParameters: [], bindings: [], resultKind: compiled.resultKind,
    displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
    targetDirection: 'none', comparisonBasis: 'none', aggregationWindow, chartType: 'none',
    templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));

    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'diesel-generator', name: 'Diesel generator',
        description: null, category: 'power', expectedSignals: [], failureModes: [],
        defaultThresholds: {}, templateSlug: 'diesel-generator', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await m.getRepository(ClientFormula).save([
        formula('per_shift', 'shift', compiled.plan),
        formula('uncompiled', '24h', null),
      ] as any);
      await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        equipmentClassSlug: 'diesel-generator', classVersion: 1, tier: 'standard', commissionedAt: null,
        serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
      });
    });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('a shift-window KPI asked without from/to: no window at all, and the reason says it could not be resolved', async () => {
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'per_shift', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'window_not_resolved', value: null, window: null });
  });

  it('the same KPI asked with an explicit window gets past the window and reports what it finds next', async () => {
    const envelope = await evaluator.evaluateOne(
      scope, EQUIPMENT, 'per_shift', NOW, { from: new Date(NOW.getTime() - 7 * DAY), to: NOW },
    );
    expect(envelope.window).toEqual({ from: new Date(NOW.getTime() - 7 * DAY).toISOString(), to: NOW.toISOString() });
    // No device is fitted, so the next honest answer is `unbound` — anything but the window.
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
  });

  it('a formula with no compiled plan is not_configured / formula_not_compiled, never a bare not_configured', async () => {
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'uncompiled', NOW);
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'formula_not_compiled', value: null });
  });

  it('evaluating every KPI for the machine gives each one a reason, not just the one asked for', async () => {
    const envelopes = await evaluator.evaluateAll(scope, EQUIPMENT, NOW);
    const notReady = envelopes.filter((e) => e.readiness !== 'ready');
    expect(notReady.length).toBeGreaterThan(0);
    for (const e of notReady) expect(e.reason).toBeDefined();
  });
});
