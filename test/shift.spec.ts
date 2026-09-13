import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const IST = 'Asia/Kolkata';

describeDb('equipment shifts', () => {
  let ds: DataSource;
  let owner: DataSource;
  let shifts: ShiftService;
  let equipment: EquipmentService;
  let plants: PlantService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read'],
  };
  const other: RequestScope = {
    tenantId: 'globex', userId: 'u-other', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read'],
  };

  const ref = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'DG-1' };
  const morning = { name: 'A', startMinute: 6 * 60, endMinute: 14 * 60, days: [1, 2, 3, 4, 5] as any, timeZone: IST };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
    equipment = new EquipmentService(ds);
    plants = new PlantService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['equipment_shift', 'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
  });

  describe('defining the working day', () => {
    it('records hours as wall-clock plus a zone, never an offset', async () => {
      const shift = await shifts.create(boss, ref, morning);
      expect(shift.timeZone).toBe(IST);
      expect(shift.startMinute).toBe(360);
      // Nothing has been scored yet, and that is not the same as "scored up to now".
      expect(shift.scoredThrough).toBeNull();
    });

    it('refuses a zone it cannot compute against', async () => {
      // The failure this prevents is silent: an unresolvable zone produces a window
      // that is wrong rather than one that fails.
      await expect(shifts.create(boss, ref, { ...morning, timeZone: 'Asia/Bengaluru' }))
        .rejects.toThrow(/not a timezone/);
      await expect(shifts.create(boss, ref, { ...morning, timeZone: 'IST' }))
        .rejects.toThrow(/region and city/);
    });

    it('accepts a three-shift day that meets exactly at the handovers', async () => {
      const days = [1, 2, 3, 4, 5] as any;
      await shifts.create(boss, ref, { ...morning, name: 'A' });
      await shifts.create(boss, ref, { name: 'B', startMinute: 14 * 60, endMinute: 22 * 60, days, timeZone: IST });
      // The night shift runs past midnight and is still a weekday shift, because a
      // shift belongs to the day it starts.
      await shifts.create(boss, ref, { name: 'C', startMinute: 22 * 60, endMinute: 6 * 60, days, timeZone: IST });
      expect(await shifts.list(boss, ref)).toHaveLength(3);
    });

    it('refuses two shifts that would score the same readings twice', async () => {
      await shifts.create(boss, ref, morning);
      await expect(shifts.create(boss, ref, {
        ...morning, name: 'Overlapping', startMinute: 13 * 60, endMinute: 21 * 60,
      })).rejects.toThrow(ConflictException);
    });

    it('catches a night shift running into the next morning', async () => {
      await shifts.create(boss, ref, {
        name: 'Night', startMinute: 22 * 60, endMinute: 7 * 60, days: [1] as any, timeZone: IST,
      });
      // Monday night runs to 07:00 Tuesday and Tuesday morning starts at 06:00.
      await expect(shifts.create(boss, ref, {
        name: 'Tuesday', startMinute: 6 * 60, endMinute: 14 * 60, days: [2] as any, timeZone: IST,
      })).rejects.toThrow(/overlaps the "Night" shift/);
    });

    it('refuses a shift too short to ever produce a baseline', async () => {
      await expect(shifts.create(boss, ref, { ...morning, startMinute: 600, endMinute: 610 }))
        .rejects.toThrow(/almost certainly a mistake/);
    });

    it('refuses a shift that runs on no days', async () => {
      await expect(shifts.create(boss, ref, { ...morning, days: [] as any }))
        .rejects.toThrow(/never be scored/);
    });

    it('refuses a shift on a machine that is not here, or is retired', async () => {
      await expect(shifts.create(boss, { ...ref, externalId: 'NOPE' }, morning))
        .rejects.toThrow(NotFoundException);
      await equipment.retire(boss, ref, 'sold');
      await expect(shifts.create(boss, ref, morning)).rejects.toThrow(/retired/);
    });

    it('lets the same shift name exist on two machines', async () => {
      await equipment.create(boss, { code: 'DG-2', name: 'Generator 2' });
      await shifts.create(boss, ref, morning);
      // Every machine in the plant has an "A" shift. Uniqueness is per machine.
      await expect(shifts.create(boss, { ...ref, externalId: 'DG-2' }, morning)).resolves.toBeTruthy();
    });
  });

  describe('what is owed', () => {
    const MONDAY_NOON_IST = new Date('2026-09-14T06:30:00.000Z');

    it('owes nothing for a shift that has not finished yet', async () => {
      await shifts.create(boss, ref, morning);
      // It is noon in Kolkata and the morning shift runs until 14:00.
      expect(await shifts.owed(MONDAY_NOON_IST)).toEqual([]);
    });

    it('owes the shift that has just finished, and only that one', async () => {
      const shift = await shifts.create(boss, ref, morning);
      const afterShift = new Date('2026-09-14T09:00:00.000Z');

      const owed = await shifts.owed(afterShift);
      expect(owed).toHaveLength(1);
      expect(owed[0]).toMatchObject({ shiftId: shift.id, externalId: 'DG-1', localDate: '2026-09-14' });
      // 06:00 to 14:00 in Kolkata is 00:30 to 08:30 UTC.
      expect(owed[0].start.toISOString()).toBe('2026-09-14T00:30:00.000Z');
      expect(owed[0].end.toISOString()).toBe('2026-09-14T08:30:00.000Z');
    });

    it('owes nothing once the watermark has moved past it', async () => {
      const shift = await shifts.create(boss, ref, morning);
      const afterShift = new Date('2026-09-14T09:00:00.000Z');
      const [owed] = await shifts.owed(afterShift);

      await shifts.markScored('acme', shift.id, owed.end);
      // The watermark is what makes the runner safe to fire as often as it likes.
      expect(await shifts.owed(afterShift)).toEqual([]);
    });

    it('does not score the whole history of a machine on its first run', async () => {
      const shift = await shifts.create(boss, ref, morning);
      await owner.query(
        `UPDATE "equipment_shift" SET "created_at" = '2020-01-01T00:00:00Z' WHERE "id" = $1`,
        [shift.id]);

      // Six years of shifts are not owed. On a fleet being onboarded this is the
      // difference between one scoring pass and several hundred thousand.
      const owed = await shifts.owed(new Date('2026-09-14T09:00:00.000Z'));
      expect(owed).toHaveLength(1);
      expect(owed[0].localDate).toBe('2026-09-14');
    });

    it('catches up in order after an outage, and caps the burst', async () => {
      const shift = await shifts.create(boss, ref, { ...morning, days: [0, 1, 2, 3, 4, 5, 6] as any });
      await shifts.markScored('acme', shift.id, new Date('2026-09-01T09:00:00.000Z'));

      const owed = await shifts.owed(new Date('2026-09-14T09:00:00.000Z'));
      // Capped, so one machine left unscored for a fortnight cannot starve every
      // other machine on the same pass. The rest are still owed next time.
      expect(owed).toHaveLength(8);
      expect(owed[0].localDate).toBe('2026-09-02');
      expect(owed.map((w) => w.end.getTime())).toEqual([...owed.map((w) => w.end.getTime())].sort((a, b) => a - b));
    });

    it('owes nothing for a retired shift, and restarts from now when reinstated', async () => {
      const at = new Date('2026-09-14T09:00:00.000Z');
      const shift = await shifts.create(boss, ref, { ...morning, days: [0, 1, 2, 3, 4, 5, 6] as any });
      await shifts.retire(boss, shift.id, at);
      expect(await shifts.owed(at)).toEqual([]);

      // A shift switched back on after a month off is not owed a month of scoring:
      // nobody wants a hundred predictions about a machine that was standing idle.
      await shifts.reinstate(boss, shift.id, at);
      expect(await shifts.owed(at)).toEqual([]);
    });

    it('sees across accounts, because the runner has no request behind it', async () => {
      await shifts.create(boss, ref, morning);
      await owner.query(
        `INSERT INTO "plant" ("tenant_id","code","name") VALUES ('globex','N','N')`);
      await equipment.create(other, { code: 'DG-1', name: 'Theirs' });
      await shifts.create(other, ref, { ...morning, timeZone: 'Europe/London' });

      const owed = await shifts.owed(new Date('2026-09-14T14:00:00.000Z'));
      // One read of what is owed across the whole platform; the scoring that follows
      // happens inside each account's own session.
      expect(owed.map((w) => w.tenantId).sort()).toEqual(['acme', 'globex']);
    });
  });

  describe('isolation', () => {
    it('keeps one account\'s working day out of another', async () => {
      const shift = await shifts.create(boss, ref, morning);
      expect(await shifts.list(other, ref)).toEqual([]);
      await expect(shifts.update(other, shift.id, { name: 'Theirs' }))
        .rejects.toThrow(NotFoundException);
    });
  });
});
