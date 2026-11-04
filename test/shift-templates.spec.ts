import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { EquipmentShift } from '../src/shift/entities/equipment-shift.entity';
import { ShiftService } from '../src/shift/services/shift.service';
import { ExpectedFuelApiService } from '../src/shift-fuel/expected-fuel-api.service';
import { withTenantSession } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ShiftTemplates1763500000000';
const TEMPLATE = 'existing-platform-day-night';

/**
 * Fuel test report, 3 Nov 2026 — FU-3 / TC-FP-08: "No shift model in the library and no
 * shift field on client equipment — instant-by-shift prediction unconfigurable."
 *
 * Retest criterion (TC-FP-02/08): a shift template exists in the library. These hold a
 * template to giving a machine its working day in one call, to being safe to call twice
 * or twice at once, to never overwriting a working day the account set — and, end to end,
 * to a new machine having expected litres for its first shift once it has one.
 */
describeDb('shift templates in the library, applied to a machine (FU-3)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let shifts: ShiftService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const ref = { sourceSystem: 'ta-2.0', externalId: 'EX-NEW-01' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "equipment_shift", "equipment_profile", "equipment_class_profile" CASCADE`);
  });

  const machine = (tenantId = 'acme', externalId = ref.externalId, status: 'active' | 'retired' = 'active') =>
    owner.getRepository(EquipmentProfile).save({
      tenantId, sourceSystem: ref.sourceSystem, externalId, status, equipmentClassSlug: 'hydraulic-excavator', classVersion: 2,
      plantId: null, tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u',
    });
  const shiftsOf = () => owner.getRepository(EquipmentShift).find({ where: ref, order: { name: 'ASC' } });

  it('the library holds the existing platform\'s day and night shifts, and an account reads them', async () => {
    const list = await shifts.templates(acme);
    expect(list.map((t) => t.slug)).toContain(TEMPLATE);
    expect(list.find((t) => t.slug === TEMPLATE)!.shifts).toEqual([
      { name: 'Day', startMinute: 480, endMinute: 1200, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' },
      { name: 'Night', startMinute: 1200, endMinute: 480, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' },
    ]);
  });

  it('an account cannot write the library: the app role is refused an insert', async () => {
    await expect(withTenantSession(ds, acme, (m) => m.query(
      `INSERT INTO "shift_template" ("slug", "name", "shifts") VALUES ('mine', 'Mine', '[{}]'::jsonb)`,
    ))).rejects.toThrow(/permission denied/);
  });

  it('applied to a new machine: its two shifts, as its own rows', async () => {
    await machine();
    const r = await shifts.applyTemplate(acme, ref, TEMPLATE);
    expect(r.created.map((s) => s.name)).toEqual(['Day', 'Night']);
    expect(r.alreadyThere).toEqual([]);
    expect((await shiftsOf()).map((s) => [s.name, s.startMinute, s.endMinute, s.timeZone, s.status, s.createdBy])).toEqual([
      ['Day', 480, 1200, 'Asia/Kolkata', 'active', 'u-acme'],
      ['Night', 1200, 480, 'Asia/Kolkata', 'active', 'u-acme'],
    ]);
  });

  it('applied twice: the second writes nothing and says both were already there', async () => {
    await machine();
    await shifts.applyTemplate(acme, ref, TEMPLATE);
    const again = await shifts.applyTemplate(acme, ref, TEMPLATE);
    expect(again).toMatchObject({ created: [], alreadyThere: ['Day', 'Night'] });
    expect(await shiftsOf()).toHaveLength(2);
  });

  it('two applies fired together both settle without error, and each shift is written once', async () => {
    await machine();
    const results = await Promise.allSettled([
      shifts.applyTemplate(acme, ref, TEMPLATE), shifts.applyTemplate(acme, ref, TEMPLATE),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const created = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.created : []));
    expect(created).toHaveLength(2);
    expect(await shiftsOf()).toHaveLength(2);
  });

  it('a "Day" shift the account set with other hours is not overwritten: refused, and nothing written', async () => {
    await machine();
    await shifts.create(acme, ref, { name: 'Day', startMinute: 420, endMinute: 900, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata' });
    await expect(shifts.applyTemplate(acme, ref, TEMPLATE)).rejects.toThrow(ConflictException);
    expect((await shiftsOf()).map((s) => [s.name, s.startMinute])).toEqual([['Day', 420]]);
  });

  it('an overlap with a hand-typed shift is refused as it would be typed by hand', async () => {
    await machine();
    await shifts.create(acme, ref, { name: 'General', startMinute: 540, endMinute: 1020, days: [1], timeZone: 'Asia/Kolkata' });
    await expect(shifts.applyTemplate(acme, ref, TEMPLATE)).rejects.toThrow(/overlaps the "General" shift/);
    expect((await shiftsOf()).map((s) => s.name)).toEqual(['General']);
  });

  it('another account\'s machine, a retired machine, and an unknown template are each refused', async () => {
    await machine('other');
    await expect(shifts.applyTemplate(acme, ref, TEMPLATE)).rejects.toThrow(NotFoundException);
    await machine('acme', 'EX-OLD', 'retired');
    await expect(shifts.applyTemplate(acme, { ...ref, externalId: 'EX-OLD' }, TEMPLATE)).rejects.toThrow(/retired/);
    await machine();
    await expect(shifts.applyTemplate(acme, ref, 'no-such-template')).rejects.toThrow(NotFoundException);
  });

  it('end to end: a machine created and given the template has expected litres for its first shift, with no history', async () => {
    await owner.getRepository(EquipmentClassProfile).save({
      slug: 'hydraulic-excavator', version: 2, name: 'Hydraulic Excavator', status: 'published', publishedAt: new Date(),
      expectedSignals: [], nominalFuelPerHour: 15, nominalFuelUnit: 'L/h', idleFuelPerHour: 2.1, workingShare: 0.7,
    });
    await machine();
    const expected = new ExpectedFuelApiService(ds);
    const at = new Date('2026-11-02T09:00:00+05:30');
    expect((await expected.machine(acme, ref, at)).shifts[0].blockedBy).toEqual(['no_shift_schedule']);

    await shifts.applyTemplate(acme, ref, TEMPLATE);
    const after = await expected.machine(acme, ref, at);
    // Twelve hours: 8.4 working at 15 L/h = 126 L; 3.6 idle at 2.1 L/h = 7.56 L.
    expect(after.shifts.map((s) => [s.shiftName, s.predictedL])).toEqual([['Day', 133.56], ['Night', 133.56]]);
  });

  it(`${MIGRATION} reverts cleanly and comes back with its template`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('shift_template') AS t`)).toEqual([{ t: null }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT slug FROM "shift_template"`)).toEqual([{ slug: TEMPLATE }]);
  });
});
