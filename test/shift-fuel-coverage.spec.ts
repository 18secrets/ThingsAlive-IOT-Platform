import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { ShiftFuelCoverageService } from '../src/shift-fuel/shift-fuel-coverage.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Fuel test report, 3 Nov 2026 — FU-6 / TC-FP-10: "Every fuel-burning machine gets a
 * per-shift forecast: 25 machines forecast, but 3100092 (burned 131.7 L that day) absent
 * from the table."
 *
 * On Development 3100092 is a 2.0 machine with fuel readings and not one shift total from
 * the existing platform, so D50 has nothing to forecast it from. Being absent is not wrong;
 * being absent without a word is. These hold the coverage route to listing it, and to
 * telling it apart from a 1.0 mirror, which D50 never matches.
 */
describeDb('which fuel-burning machines the shift fuel forecast covers (FU-6)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let coverage: ShiftFuelCoverageService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u', roles: ['admin'], isPlatformRole: false };
  const NOV3 = { from: '2026-11-03', to: '2026-11-03' };
  const AT = new Date('2026-11-04T09:00:00+05:30');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    coverage = new ShiftFuelCoverageService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "signal_binding_version", "legacy_shift_metric", "equipment_profile" CASCADE`);
  });

  const machine = (externalId: string, o: { tenant?: string; source?: string; name?: string; status?: 'active' | 'retired' } = {}) =>
    owner.getRepository(EquipmentProfile).save({
      tenantId: o.tenant ?? 'acme', sourceSystem: o.source ?? 'ta-2.0', externalId, name: o.name ?? externalId,
      status: o.status ?? 'active', equipmentClassSlug: null, classVersion: null, plantId: null, tier: 'standard',
      commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    });
  const bind = (externalId: string, signal: string, o: { tenant?: string; source?: string; from?: string; to?: string | null; status?: string } = {}) =>
    owner.getRepository(SignalBindingVersion).save({
      tenantId: o.tenant ?? 'acme', sourceSystem: o.source ?? 'ta-2.0', externalId, signalKey: signal, measurementRole: signal,
      componentId: '', origin: 'physical' as const, imei: `imei-${externalId}`, channel: 'ch', sensorInstanceId: null,
      canonicalUnit: 'L/h', sourceUnit: null, validFrom: new Date(o.from ?? '2026-10-01T00:00:00Z'),
      validTo: o.to ? new Date(o.to) : null, expectedPeriodSeconds: 300, isPrimary: true,
      status: (o.status ?? (o.to ? 'superseded' : 'active')) as 'active', discoveredFrom: null, discoveredBy: 'manual' as const,
      approvedBy: 'u', approvedAt: new Date('2026-10-01T00:00:00Z'),
    });
  const total = (externalId: string, sdate: string, fuel: number | null, tenant = 'acme') => owner.query(
    `INSERT INTO "legacy_shift_metric" ("tenant_id", "source_system", "external_id", "sdate", "shift", "fuel_l", "work_hrs", "synced_at")
       VALUES ($1, 'ta-2.0', $2, $3, 1, $4, 10, now())`,
    [tenant, externalId, sdate, fuel],
  );

  it('3100092 burns fuel in 2.0 and has no shift total: listed as not covered, beside one that is', async () => {
    await machine('3100092', { name: 'Shutter Converter · 3100092' });
    await bind('3100092', 'fuel_consumption');
    await machine('3100078');
    await bind('3100078', 'fuel_level');
    await total('3100078', '2026-11-03', 120.5);

    const r = await coverage.coverage(acme, NOV3, AT);
    expect(r).toMatchObject({ fuelled: 2, covered: 1 });
    expect(r.notCovered).toEqual([
      { sourceSystem: 'ta-2.0', externalId: '3100092', name: 'Shutter Converter · 3100092', reason: 'no_shift_totals' },
    ]);
  });

  it('a 1.0 mirror is said to be one: D50 never matches it, whatever its id', async () => {
    await machine('4471', { source: 'iot-platform-1' });
    await bind('4471', 'fuel_level', { source: 'iot-platform-1' });
    expect((await coverage.coverage(acme, NOV3, AT)).notCovered).toEqual([
      expect.objectContaining({ externalId: '4471', reason: 'mirrored_from_1_0' }),
    ]);
  });

  it('a total with no figure is not a total; a total outside the range does not cover the range', async () => {
    await machine('A'); await bind('A', 'fuel_consumption'); await total('A', '2026-11-03', null);
    await machine('B'); await bind('B', 'fuel_consumption'); await total('B', '2026-11-01', 80);
    const r = await coverage.coverage(acme, NOV3, AT);
    expect(r.notCovered.map((n) => n.externalId)).toEqual(['A', 'B']);
  });

  it('no fuel sensor, retired, unbound before the range, or a rejected binding: not a fuel-burning machine in it', async () => {
    await machine('NO-FUEL'); await bind('NO-FUEL', 'engine_load');
    await machine('RETIRED', { status: 'retired' }); await bind('RETIRED', 'fuel_consumption');
    await machine('CAME-OFF'); await bind('CAME-OFF', 'fuel_consumption', { to: '2026-11-01T00:00:00Z' });
    await machine('REJECTED'); await bind('REJECTED', 'fuel_consumption', { status: 'rejected' });
    expect(await coverage.coverage(acme, NOV3, AT)).toMatchObject({ fuelled: 0, covered: 0, notCovered: [] });
  });

  it('another account\'s machines are not seen, and a narrowed scope sees only its own', async () => {
    await machine('3100092', { tenant: 'other' }); await bind('3100092', 'fuel_consumption', { tenant: 'other' });
    await machine('MINE'); await bind('MINE', 'fuel_consumption');
    await machine('NOT-MINE'); await bind('NOT-MINE', 'fuel_consumption');
    expect((await coverage.coverage(acme, NOV3, AT)).notCovered.map((n) => n.externalId)).toEqual(['MINE', 'NOT-MINE']);
    expect((await coverage.coverage({ ...acme, equipmentIds: ['MINE'] }, NOV3, AT)).notCovered.map((n) => n.externalId))
      .toEqual(['MINE']);
  });
});
