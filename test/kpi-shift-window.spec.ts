import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { compileFormula } from '../src/catalog/formula/formula-compiler';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { KpiEvaluatorService, shiftWindow } from '../src/kpi/services/kpi-evaluator.service';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const shift = (startMinute: number, endMinute: number, days = [0, 1, 2, 3, 4, 5, 6]) =>
  ({ startMinute, endMinute, days, timeZone: 'UTC', status: 'active' }) as unknown as EquipmentShift;

/**
 * A `shift` aggregation window is the machine's shift (dev: avg_engine_load_to_avg_fuel_level_ratio
 * on every hydraulic excavator read "the formula's own window can't be resolved yet").
 * Resolved from the machine's own schedule with Availability's arithmetic.
 */
describe('shift window', () => {
  // Monday 2026-09-21. A day shift 08:00–18:00 UTC.
  const at = (iso: string) => new Date(`2026-09-21T${iso}:00.000Z`);

  it('during a shift: from the shift\'s start to now', () => {
    expect(shiftWindow([shift(8 * 60, 18 * 60)], at('11:30')))
      .toEqual({ from: at('08:00'), to: at('11:30') });
  });

  it('between shifts: the shift that ended last, whole', () => {
    expect(shiftWindow([shift(8 * 60, 18 * 60)], at('20:00')))
      .toEqual({ from: at('08:00'), to: at('18:00') });
    expect(shiftWindow([shift(8 * 60, 18 * 60)], at('06:00')))
      .toEqual({ from: new Date('2026-09-20T08:00:00.000Z'), to: new Date('2026-09-20T18:00:00.000Z') });
  });

  it('a night shift across midnight is one window, not two halves', () => {
    expect(shiftWindow([shift(22 * 60, 6 * 60)], at('02:00')))
      .toEqual({ from: new Date('2026-09-20T22:00:00.000Z'), to: at('02:00') });
  });

  it('no schedule, or none scheduled in the last eight days: no window', () => {
    expect(shiftWindow([], at('11:30'))).toBeNull();
    expect(shiftWindow([shift(8 * 60, 18 * 60, [])], at('11:30'))).toBeNull();
  });
});

describeDb('a shift-window KPI on a machine with a schedule', () => {
  let owner: DataSource;
  let ds: DataSource;
  let evaluator: KpiEvaluatorService;
  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const EQUIPMENT = { sourceSystem: 'iot-platform-1', externalId: 'DG-S' };
  const NOW = new Date('2026-09-22T12:00:00.000Z');
  const compiled = compileFormula({
    formulaKey: 'avg_coolant', expression: 'avg(coolant_temp_c)', classSlug: 'diesel-generator',
    expectedSignals: [{ signal: 'coolant_temp_c', unit: 'degC' }],
  });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    evaluator = new KpiEvaluatorService(ds, new SignalBindingService(ds));
    await runTenantSpanning(owner, 'test fixture', async (m) => {
      await m.getRepository(ClientEquipmentClass).save({
        tenantId: 'acme', slug: 'diesel-generator', name: 'Diesel generator', description: null, category: 'power',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'diesel-generator', templateVersion: 1,
        templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      });
      await m.getRepository(ClientFormula).save({
        tenantId: 'acme', clientEquipmentClassSlug: 'diesel-generator', formulaKey: 'per_shift', kind: 'empirical',
        expression: 'avg(coolant_temp_c)', compiledPlan: compiled.plan as any, compiledAt: NOW,
        compilerVersion: compiled.compilerVersion, resultUnit: compiled.resultUnit, requiredSignals: compiled.requiredSignals,
        requiredParameters: [], bindings: [], resultKind: compiled.resultKind, displayUnit: null, displayFormat: 'number:1',
        targetValue: null, targetMin: null, targetMax: null, targetDirection: 'none', comparisonBasis: 'none',
        aggregationWindow: 'shift', chartType: 'none', templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
      } as any);
      await m.getRepository(EquipmentProfile).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId,
        equipmentClassSlug: 'diesel-generator', classVersion: 1, tier: 'standard', commissionedAt: null,
        serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
      });
      await m.getRepository(EquipmentShift).save({
        tenantId: 'acme', sourceSystem: EQUIPMENT.sourceSystem, externalId: EQUIPMENT.externalId, name: 'Day',
        startMinute: 8 * 60, endMinute: 18 * 60, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC', status: 'active',
      });
    });
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('asked without from/to, it gets today\'s shift so far and moves on to what it finds next', async () => {
    const envelope = await evaluator.evaluateOne(scope, EQUIPMENT, 'per_shift', NOW);
    expect(envelope.window).toEqual({ from: '2026-09-22T08:00:00.000Z', to: NOW.toISOString() });
    // No device is fitted, so the next honest answer is `unbound` — anything but the window.
    expect(envelope).toMatchObject({ readiness: 'not_configured', reason: 'unbound' });
  });
});
