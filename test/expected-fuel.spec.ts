import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { readFuelFigures, writeFuelFigures } from '../src/catalog/services/class-fuel-figures';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { ClassFuelFigures, DIESEL_DENSITY_G_PER_L, expectedShiftFuel } from '../src/shift-fuel/expected-fuel';
import { ExpectedFuelApiService } from '../src/shift-fuel/expected-fuel-api.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';


/** The fuel figures are written through `class-fuel-figures.ts`, as the import and authoring do. */
const FUEL_KEYS = ['nominalFuelSource', 'ratedPowerKw', 'workingLoadPct', 'bsfcGPerKwh', 'bsfcSource', 'idleFuelPerHour', 'workingShare'] as const;
async function saveClass(o: DataSource, row: Record<string, unknown>): Promise<EquipmentClassProfile> {
  const fuel = Object.fromEntries(FUEL_KEYS.filter((k) => k in row).map((k) => [k, row[k]]));
  const rest = Object.fromEntries(Object.entries(row).filter(([k]) => !(FUEL_KEYS as readonly string[]).includes(k)));
  // One transaction, as the import's: a refused figure leaves no class row behind.
  return o.transaction(async (m) => {
    const saved = await m.getRepository(EquipmentClassProfile).save(rest as Partial<EquipmentClassProfile>);
    if (Object.keys(fuel).length) await writeFuelFigures(m, saved.id, fuel);
    return saved;
  });
}

/**
 * Fuel test report, 3 Nov 2026 — TC-FP-07 / TC-FP-09 (FU-3): "Instant prediction for a new
 * machine from equipment + shift: impossible", and "Prediction works cold-start (day 1,
 * zero history): scenario requires 7 days".
 *
 * Retest criterion: a brand-new machine with a shift assigned shows predicted litres for
 * its first shift BEFORE any history exists. These hold the arithmetic to hand-worked
 * litres, and the service to answering for a machine with no reading, no shift total and
 * no forecast anywhere — and to refusing to answer, by name, when a figure is missing.
 */
const unset: ClassFuelFigures = {
  classSlug: 'hydraulic-excavator', classVersion: 2, className: 'Hydraulic Excavator',
  nominalFuelPerHour: null, nominalFuelUnit: null, nominalFuelSource: null,
  ratedPowerKw: null, workingLoadPct: null, bsfcGPerKwh: null, bsfcSource: null,
  idleFuelPerHour: null, workingShare: null,
};
const physics: ClassFuelFigures = {
  ...unset, ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1 performance data',
  idleFuelPerHour: 2.1, workingShare: 0.7,
};

describe('expected litres per shift, by hand', () => {
  it('power × load × BSFC ÷ 835: 121 kW at 60 % and 215 g/kWh is 18.69 L/h; ten hours at 70 % working, 3 h idle at 2.1', () => {
    // 121 × 0.6 × 215 = 15 609 g/h; ÷ 835 = 18.6934 L/h. 7 h → 130.854 L; 3 h × 2.1 → 6.3 L.
    expect(DIESEL_DENSITY_G_PER_L).toBe(835);
    const r = expectedShiftFuel(physics, 10);
    expect(r).toMatchObject({ predictedL: 137.15, workingL: 130.85, idleL: 6.3, workingRateFrom: 'bsfc', blockedBy: [] });
    expect(r.inputs.find((i) => i.name === 'working_fuel_per_hour')?.value).toBe(18.69);
    expect(r.inputs.find((i) => i.name === 'bsfc_g_per_kwh')?.source).toContain('Cat C7.1 performance data');
  });

  it('no BSFC recorded: the class nominal is the working rate — 15 L/h, twelve hours, 70 % working', () => {
    // 12 × 0.7 = 8.4 h × 15 = 126 L; 3.6 h × 2.1 = 7.56 L.
    const r = expectedShiftFuel({
      ...unset, nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleFuelPerHour: 2.1, workingShare: 0.7,
    }, 12);
    expect(r).toMatchObject({ predictedL: 133.56, workingL: 126, idleL: 7.56, workingRateFrom: 'nominal' });
    expect(r.inputs.find((i) => i.name === 'working_fuel_per_hour')?.source).toContain('no datasheet recorded');
  });

  it('a share of 1 has no idle hours, so it needs no idle burn', () => {
    expect(expectedShiftFuel({ ...physics, idleFuelPerHour: null, workingShare: 1 }, 10))
      .toMatchObject({ predictedL: 186.93, idleL: 0, blockedBy: [] });
  });

  it('nothing set: blocked, and every missing figure is named at once, never a zero', () => {
    expect(expectedShiftFuel(unset, 12)).toMatchObject({
      predictedL: null, workingL: null, idleL: null,
      blockedBy: ['working_rate_not_set', 'working_share_not_set', 'idle_fuel_per_hour_not_set'],
    });
  });

  it('a nominal in another unit is refused, not converted', () => {
    expect(expectedShiftFuel({ ...physics, ratedPowerKw: null, workingLoadPct: null, bsfcGPerKwh: null, bsfcSource: null,
      nominalFuelPerHour: 4, nominalFuelUnit: 'gal/h' }, 12).blockedBy).toEqual(['nominal_unit_not_litres']);
  });

  it('no schedule and no class are blockers too: the hours are the schedule\'s, never a guessed day', () => {
    expect(expectedShiftFuel(physics, null).blockedBy).toEqual(['no_shift_schedule']);
    expect(expectedShiftFuel(null, null).blockedBy).toEqual(['no_class', 'no_shift_schedule']);
  });
});

describeDb('a brand-new machine gets its first shift\'s litres before any history exists (TC-FP-07/09)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let api: ExpectedFuelApiService;

  const scope: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const SRC = 'ta-2.0';
  const CLASS = 'hydraulic-excavator';
  // Monday 2026-11-02, 09:00 in India: the day shift (08:00–20:00) is under way.
  const NOW = new Date('2026-11-02T09:00:00+05:30');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    api = new ExpectedFuelApiService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "equipment_shift", "equipment_profile", "equipment_class_profile",
      "telemetry_reading", "legacy_shift_metric", "shift_fuel_forecast" CASCADE`);
  });

  const klass = (figures: Record<string, unknown>) => saveClass(owner, {
    slug: CLASS, version: 2, name: 'Hydraulic Excavator', status: 'published', publishedAt: NOW,
    expectedSignals: [{ signal: 'fuel_level', unit: '%', required: true }], ...figures,
  });
  const machine = (id: string, tenant = 'acme') => owner.getRepository(EquipmentProfile).save({
    tenantId: tenant, sourceSystem: SRC, externalId: id, equipmentClassSlug: CLASS, classVersion: 2,
    plantId: null, tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
  });
  /** The existing platform's two shifts, as this machine's own schedule. */
  const dayAndNight = async (id: string, tenant = 'acme') => {
    for (const [name, start, end] of [['Day', 8 * 60, 20 * 60], ['Night', 20 * 60, 8 * 60]] as const) {
      await owner.getRepository(EquipmentShift).save({
        tenantId: tenant, sourceSystem: SRC, externalId: id, name, startMinute: start, endMinute: end,
        days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: 'Asia/Kolkata', status: 'active', // eslint-disable-line @typescript-eslint/no-explicit-any
        scoredThrough: null, arrivalsThrough: null, createdBy: 'u', updatedBy: 'u',
      });
    }
  };

  it('created a minute ago, no reading, no shift total, no forecast: the day shift and the night shift are predicted', async () => {
    await klass({
      ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1 performance data',
      idleFuelPerHour: 2.1, workingShare: 0.7,
    });
    await machine('EX-NEW-01');
    await dayAndNight('EX-NEW-01');
    // Nothing about this machine exists anywhere but its record and its schedule.
    for (const table of ['telemetry_reading', 'legacy_shift_metric', 'shift_fuel_forecast']) {
      expect(await owner.query(`SELECT 1 FROM "${table}"`)).toEqual([]);
    }

    const r = await api.machine(scope, { sourceSystem: SRC, externalId: 'EX-NEW-01' }, NOW);
    expect(r.equipmentClass).toEqual({ slug: CLASS, version: 2, name: 'Hydraulic Excavator' });
    expect(r.shifts.map((s) => [s.shiftName, s.startsAt, s.endsAt])).toEqual([
      ['Day', '2026-11-02T02:30:00.000Z', '2026-11-02T14:30:00.000Z'],
      ['Night', '2026-11-02T14:30:00.000Z', '2026-11-03T02:30:00.000Z'],
    ]);
    // Twelve hours: 8.4 working at 18.69341 L/h = 157.0247 L; 3.6 idle at 2.1 = 7.56 L; 164.5847 L.
    for (const s of r.shifts) {
      expect(s).toMatchObject({ predictedL: 164.58, workingL: 157.02, idleL: 7.56, blockedBy: [], workingRateFrom: 'bsfc' });
    }
  });

  it('the class has no figures yet (the library\'s state today): blocked on each, by name, and no number', async () => {
    await klass({});
    await machine('EX-NEW-01');
    await dayAndNight('EX-NEW-01');
    const r = await api.machine(scope, { sourceSystem: SRC, externalId: 'EX-NEW-01' }, NOW);
    expect(r.shifts).toHaveLength(2);
    for (const s of r.shifts) {
      expect(s).toMatchObject({
        predictedL: null, blockedBy: ['working_rate_not_set', 'working_share_not_set', 'idle_fuel_per_hour_not_set'],
      });
    }
  });

  it('no shift assigned: one entry, blocked on the schedule as well as on whatever the class lacks', async () => {
    await klass({ nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleFuelPerHour: 2.1, workingShare: 0.7 });
    await machine('EX-NEW-01');
    const r = await api.machine(scope, { sourceSystem: SRC, externalId: 'EX-NEW-01' }, NOW);
    expect(r.shifts).toEqual([expect.objectContaining({ shiftName: null, predictedL: null, blockedBy: ['no_shift_schedule'] })]);
  });

  it('another account\'s machine of the same number is not found, and neither is one outside the caller\'s scope', async () => {
    await klass({ nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleFuelPerHour: 2.1, workingShare: 0.7 });
    await machine('EX-NEW-01', 'other');
    await dayAndNight('EX-NEW-01', 'other');
    await expect(api.machine(scope, { sourceSystem: SRC, externalId: 'EX-NEW-01' }, NOW)).rejects.toThrow(NotFoundException);
    await machine('EX-NEW-01');
    await expect(api.machine({ ...scope, equipmentIds: ['EX-OTHER'] }, { sourceSystem: SRC, externalId: 'EX-NEW-01' }, NOW))
      .rejects.toThrow(NotFoundException);
  });
});
