import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { OemFigures, oemFigureProblems } from '../src/catalog/services/content-validation';
import { oemFiguresFromRow } from '../src/catalog-import/services/class-content';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { Plant } from '../src/equipment/entities/plant.entity';
import { DeviceProjection } from '../src/projection/entities/device-projection.entity';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { TelemetryReading } from '../src/telemetry/telemetry-reading.entity';
import { OeeService } from '../src/utilization/services/oee.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIGRATION = 'ClassFuelFigures1763400000000';

/**
 * Fuel test report, 3 Nov 2026 — FU-5 / TC-FP-05: "Nominal 14.97 L/h is an untraceable
 * 'OEM figure' while Cost Admin says the parameter is unset."
 *
 * The figure was the library's: Shutter Converter carried 15 L/h, and 149.7 L over 9.98
 * productive hours is what the page showed as nominal litres. Nothing on the page said
 * which class, which version, or which datasheet. These hold the page's source of truth —
 * the OEE result — to naming all three, and the database to refusing a fuel figure that
 * cannot be traced.
 */
describe('the cold-start fuel figures, said in sentences before the database says them in constraints', () => {
  const unset: OemFigures = oemFiguresFromRow({});

  it('blank is fine: a class with no fuel figures is unset, not invalid', () => {
    expect(oemFigureProblems(unset, [])).toEqual([]);
  });

  it('a BSFC with no datasheet, or without the power and load it multiplies, is refused by name', () => {
    expect(oemFigureProblems({ ...unset, bsfcGPerKwh: 215 }, [])).toEqual([
      'bsfc_g_per_kwh needs rated_power_kw and working_load_pct beside it; on its own it computes no litres.',
      'bsfc_g_per_kwh has no bsfc_source; name the datasheet the figure was read from.',
    ]);
  });

  it('a working share is a share of the shift: 1.5 is refused, 1 is not', () => {
    expect(oemFigureProblems({ ...unset, workingShare: 1.5 }, [])).toEqual([
      'working_share must be above 0 and at most 1 (a share of the shift), not 1.5.',
    ]);
    expect(oemFigureProblems({ ...unset, workingShare: 1 }, [])).toEqual([]);
  });

  it('the import reads every figure off the row, and a source with no nominal is refused', () => {
    const row = oemFiguresFromRow({
      nominal_fuel_source: 'Cat 320 spec sheet AEHQ8392', rated_power_kw: '121', working_load_pct: '60',
      bsfc_g_per_kwh: '215', bsfc_source: 'Cat C7.1 performance data', idle_fuel_per_hour: '2.1', working_share: '0.7',
    });
    expect(row).toMatchObject({
      nominalFuelSource: 'Cat 320 spec sheet AEHQ8392', ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215,
      bsfcSource: 'Cat C7.1 performance data', idleFuelPerHour: 2.1, workingShare: 0.7,
    });
    expect(oemFigureProblems(row, [])).toEqual([
      'nominal_fuel_source is set with no nominal_fuel_per_hour; a source of nothing traces nothing.',
    ]);
  });
});

describeDb('the nominal says where it came from (FU-5)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let oee: OeeService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const SRC = 'ta-2.0';
  const CLASS = 'shutter-converter';
  const MONDAY = Date.UTC(2026, 9, 5);
  const at = (h: number, m = 0) => MONDAY + h * HOUR + m * MIN;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    oee = new OeeService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const klass = (extra: Partial<EquipmentClassProfile> = {}) => owner.getRepository(EquipmentClassProfile).save({
    slug: CLASS, version: 1, name: 'Shutter Converter', status: 'published', publishedAt: new Date(MONDAY),
    expectedSignals: ['engine_running_status', 'engine_load', 'fuel_level', 'fuel_consumption']
      .map((signal) => ({ signal, unit: 'x', required: true })),
    nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleBreakdownThresholdMinutes: 30,
    runningSignal: 'engine_load', runningIdleBound: 20, availabilitySignal: 'fuel_level',
    ...extra,
  });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "breakdown_event", "telemetry_reading", "signal_binding_version", "equipment_shift",
        "device_projection", "tenant_parameter", "equipment_profile", "plant", "equipment_class_profile" CASCADE`,
    );
  });

  /** One machine of the class, bound and scheduled 06:00–16:00 Monday, burning 15 L/h all shift. */
  const worked = async (id: string) => {
    const plantId = (await owner.getRepository(Plant).save(owner.getRepository(Plant).create({
      tenantId: 'acme', code: `p-${id}`, name: 'North', status: 'active',
    }))).id;
    const profile = await owner.getRepository(EquipmentProfile).save({
      tenantId: 'acme', sourceSystem: SRC, externalId: id, equipmentClassSlug: CLASS, classVersion: 1,
      plantId, tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    });
    const imei = `imei-${id}`;
    await owner.getRepository(DeviceProjection).save({
      sourceSystem: SRC, externalId: `dev-${id}`, tenantId: 'acme', payload: {}, sourceUpdatedAt: null,
      syncedAt: new Date(MONDAY), checksum: 'c', status: 'live', imei, equipmentExternalId: id, name: null,
    });
    const units: Record<string, string> = { engine_running_status: 'state', engine_load: '%', fuel_level: '%', fuel_consumption: 'L/h' };
    await owner.getRepository(SignalBindingVersion).save(Object.entries(units).map(([signal, unit], i) => ({
      tenantId: 'acme', sourceSystem: SRC, externalId: id, signalKey: signal, measurementRole: signal,
      componentId: '', origin: 'physical' as const, imei, channel: `ch${i}`, sensorInstanceId: null,
      canonicalUnit: unit, sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null,
      expectedPeriodSeconds: 300, isPrimary: true, status: 'active' as const, discoveredFrom: null,
      discoveredBy: 'manual' as const, approvedBy: 'u', approvedAt: new Date(MONDAY),
    })));
    await owner.getRepository(EquipmentShift).save({
      tenantId: 'acme', sourceSystem: SRC, externalId: id, name: 'Day', startMinute: 6 * 60, endMinute: 16 * 60,
      days: [1] as any, timeZone: 'UTC', status: 'active', // eslint-disable-line @typescript-eslint/no-explicit-any
      scoredThrough: null, arrivalsThrough: null, createdBy: 'u', updatedBy: 'u',
    });
    const rows = [];
    for (let t = at(6); t < at(16); t += 5 * MIN) {
      for (const [signal, value] of [['engine_running_status', 1], ['engine_load', 60], ['fuel_level', 50], ['fuel_consumption', 15]] as [string, number][]) {
        rows.push({ tenantId: 'acme', imei, signal, value, unit: null, sourceTimestamp: new Date(t), receivedAt: new Date(t), source: 'live' as const });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await owner.getRepository(TelemetryReading).save(rows.slice(i, i + 500));
    return profile;
  };
  const day = (id: string) => oee.forEquipment(scope, { sourceSystem: SRC, externalId: id }, 'day', new Date(MONDAY), new Date(MONDAY + DAY));

  it('a library nominal names the class, the version the machine is on, and says it has no datasheet', async () => {
    await klass();
    await worked('3100092');
    const { quality } = await day('3100092');
    // Ten productive hours at 15 L/h: the 150 L the page shows as nominal litres.
    expect(quality).toMatchObject({ readiness: 'ready', nominalFuel: 150, nominalFuelPerHour: 15, nominalRateUnit: 'L/h' });
    expect(quality.nominalOrigin).toEqual({
      kind: 'library', classSlug: CLASS, classVersion: 1, className: 'Shutter Converter', citation: null,
    });
  });

  it('with a datasheet recorded, the nominal carries it', async () => {
    await klass({ nominalFuelSource: 'Manufacturer datasheet SC-200, table 4' });
    await worked('3100092');
    expect((await day('3100092')).quality.nominalOrigin).toMatchObject({
      kind: 'library', citation: 'Manufacturer datasheet SC-200, table 4',
    });
  });

  it('when Quality cannot be computed, the nominal and its origin are still said', async () => {
    await klass();
    await worked('3100092');
    await owner.query(`DELETE FROM "telemetry_reading" WHERE "signal" = 'fuel_consumption'`);
    const { quality } = await day('3100092');
    expect(quality).toMatchObject({ value: null, readiness: 'blocked', reason: 'stale', nominalFuelPerHour: 15 });
    expect(quality.nominalOrigin).toMatchObject({ kind: 'library', className: 'Shutter Converter' });
  });

  it('an account\'s own nominal wins, and the origin says it was the account, at which scope', async () => {
    await klass();
    const profile = await worked('3100092');
    await owner.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ('acme', 'equipment', $1, 'nominal_fuel_per_hour', '12'::jsonb, 'L/h', '2026-01-01', 'u')`,
      [profile.id],
    );
    const { quality } = await day('3100092');
    expect(quality).toMatchObject({ nominalFuelPerHour: 12, parameterSource: 'equipment' });
    expect(quality.nominalOrigin).toEqual({ kind: 'parameter', scope: 'equipment' });
  });

  // ============================================================ the database refuses
  it('the database refuses a datasheet beside no nominal', async () => {
    await expect(klass({ nominalFuelPerHour: null, nominalFuelUnit: null, nominalFuelSource: 'a datasheet' }))
      .rejects.toThrow(/ck_class_nominal_fuel_source/);
  });

  it('the database refuses a BSFC with no datasheet, and one without power and load', async () => {
    await expect(klass({ ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215 }))
      .rejects.toThrow(/ck_class_bsfc_complete/);
    await expect(klass({ bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1 performance data' }))
      .rejects.toThrow(/ck_class_bsfc_complete/);
  });

  it('the database refuses a working share over 1, a load over 100 %, and a non-positive idle burn', async () => {
    await expect(klass({ workingShare: 1.5 })).rejects.toThrow(/ck_class_working_share/);
    await expect(klass({ workingLoadPct: 120 })).rejects.toThrow(/ck_class_working_load_pct/);
    await expect(klass({ idleFuelPerHour: 0 })).rejects.toThrow(/ck_class_idle_fuel_positive/);
  });

  it('a complete set of figures is accepted and read back as written', async () => {
    await klass({
      ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1 performance data',
      idleFuelPerHour: 2.1, workingShare: 0.7, nominalFuelSource: 'Cat 320 spec sheet',
    });
    expect(await owner.getRepository(EquipmentClassProfile).findOneByOrFail({ slug: CLASS, version: 1 })).toMatchObject({
      ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, idleFuelPerHour: 2.1, workingShare: 0.7,
    });
  });

  it(`${MIGRATION} reverts cleanly and comes back`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const cols = async () => (await owner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'equipment_class_profile' AND column_name = 'bsfc_g_per_kwh'`,
    )).length;
    expect(await cols()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await cols()).toBe(1);
  });
});
