import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { runTenantSpanning, withTenantId, withTenantSession } from '../../scope/tenant-session';
import { EquipmentShift } from '../entities/equipment-shift.entity';
import {
  isValidTimeZone, MINUTES_PER_DAY, nominalLengthMinutes, ShiftDefinition, shiftsOverlap,
  ShiftWindow, Weekday, windowsEndingBetween,
} from './shift-window';

export interface ShiftInput {
  name: string;
  startMinute: number;
  endMinute: number;
  days: Weekday[];
  timeZone: string;
}

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}

export interface OwedWindow extends ShiftWindow {
  shiftId: string;
  shiftName: string;
  sourceSystem: string;
  externalId: string;
  tenantId: string;
}

/**
 * A shift shorter than this is more likely a typo than a shift.
 *
 * Half an hour of telemetry will not clear the scorer's minimum-sample rule, so the
 * machine would look permanently unscoreable for no visible reason: every window
 * produces a prediction of confidence 'none', and nobody would connect that to a
 * mistyped end time months earlier.
 */
export const MINIMUM_SHIFT_MINUTES = 30;

/**
 * How far back a shift that has never been scored looks for its first window.
 *
 * Wide enough that a pass firing late, or a service restarted the next morning, still
 * finds the instance that has just finished; only the most recent one is taken, so
 * widening it costs nothing and narrowing it silently skips a shift.
 */
export const FIRST_RUN_LOOK_BACK_DAYS = 3;

/**
 * The client's working day (task P1-109).
 *
 * Owned by the CEO or manager, like the equipment master it hangs off. Every method
 * runs inside the caller's own account, so a shift on somebody else's machine is not
 * refused — it is not there.
 */
@Injectable()
export class ShiftService {
  constructor(private readonly ds: DataSource) {}

  async list(scope: RequestScope, ref: EquipmentRef): Promise<EquipmentShift[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentShift).find({
        where: { tenantId: scope.tenantId, ...ref },
        order: { startMinute: 'ASC' },
      }));
  }

  async create(scope: RequestScope, ref: EquipmentRef, input: ShiftInput): Promise<EquipmentShift> {
    this.validate(input);
    return withTenantSession(this.ds, scope, async (m) => {
      const asset = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, ...ref },
      });
      if (!asset) throw new NotFoundException('No such machine in this account.');
      if (asset.status === 'retired') {
        throw new BadRequestException('That machine is retired. It has no working day.');
      }

      await this.assertNoOverlap(m, scope, ref, input, null);

      const repo = m.getRepository(EquipmentShift);
      return repo.save(repo.create({
        tenantId: scope.tenantId, ...ref,
        name: input.name.trim(),
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        days: input.days,
        timeZone: input.timeZone,
        status: 'active',
        // Null, not now. The first run scores the shift that has just finished rather
        // than every shift since the machine was commissioned, which on a fleet being
        // onboarded is the difference between one scoring pass and several thousand.
        scoredThrough: null,
        createdBy: scope.userId,
        updatedBy: scope.userId,
      }));
    });
  }

  async update(
    scope: RequestScope, id: string, input: Partial<ShiftInput>,
  ): Promise<EquipmentShift> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(EquipmentShift);
      const shift = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!shift) throw new NotFoundException('No such shift in this account.');

      const merged: ShiftInput = {
        name: input.name ?? shift.name,
        startMinute: input.startMinute ?? shift.startMinute,
        endMinute: input.endMinute ?? shift.endMinute,
        days: input.days ?? shift.days,
        timeZone: input.timeZone ?? shift.timeZone,
      };
      this.validate(merged);
      await this.assertNoOverlap(
        m, scope, { sourceSystem: shift.sourceSystem, externalId: shift.externalId }, merged, id,
      );

      Object.assign(shift, merged, { name: merged.name.trim(), updatedBy: scope.userId });
      return repo.save(shift);
    });
  }

  /**
   * Stop a shift without deleting it.
   *
   * Predictions and jobs point at windows this shift defined. Deleting the row would
   * leave those unexplainable — "scored for the 06:00 shift" with no 06:00 shift.
   */
  async retire(scope: RequestScope, id: string, now = new Date()): Promise<EquipmentShift> {
    return this.setStatus(scope, id, 'retired', now);
  }

  async reinstate(scope: RequestScope, id: string, now = new Date()): Promise<EquipmentShift> {
    return this.setStatus(scope, id, 'active', now);
  }

  private async setStatus(
    scope: RequestScope, id: string, status: 'active' | 'retired', now: Date,
  ): Promise<EquipmentShift> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(EquipmentShift);
      const shift = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!shift) throw new NotFoundException('No such shift in this account.');

      if (status === 'active' && shift.status !== 'active') {
        // A shift switched back on after a month off would otherwise be owed a month
        // of scoring the moment it returns.
        shift.scoredThrough = now;
        await this.assertNoOverlap(
          m, scope, { sourceSystem: shift.sourceSystem, externalId: shift.externalId },
          shift, id,
        );
      }
      shift.status = status;
      shift.updatedBy = scope.userId;
      return repo.save(shift);
    });
  }

  /**
   * Every shift across every account that has finished and not been scored.
   *
   * Tenant-spanning on purpose: the runner has no request behind it and no single
   * customer to be acting for. It is a read of what is owed; the scoring that follows
   * happens inside each account's own session.
   */
  async owed(now = new Date(), limitPerShift = 8): Promise<OwedWindow[]> {
    const shifts: EquipmentShift[] = await runTenantSpanning(
      this.ds, 'shift runner: what is owed',
      (m) => m.getRepository(EquipmentShift).find({ where: { status: 'active' } }));

    const out: OwedWindow[] = [];
    for (const shift of shifts) {
      const firstRun = !shift.scoredThrough;
      // A shift that has never run looks back far enough to be sure of catching the
      // instance that has just finished, however late this pass is firing — and then
      // keeps only that one. Backing off by a fixed amount instead is wrong in both
      // directions at once: too little and a pass running ten hours late misses the
      // shift entirely, too much and a daily shift returns two.
      const after = shift.scoredThrough
        ?? new Date(now.getTime() - FIRST_RUN_LOOK_BACK_DAYS * MINUTES_PER_DAY * 60_000);

      const all = windowsEndingBetween(shift as ShiftDefinition, after, now);
      // The most recent one only on a first run: the history of a machine before 2.0
      // knew about it is not owed, and on a fleet being onboarded the difference is
      // one scoring pass against several hundred thousand.
      const windows = firstRun ? all.slice(-1) : all;
      // Capped so one machine left unscored for a month cannot starve every other
      // machine on the same pass. The rest are still owed on the next one.
      for (const w of windows.slice(0, limitPerShift)) {
        out.push({
          ...w,
          shiftId: shift.id, shiftName: shift.name, tenantId: shift.tenantId,
          sourceSystem: shift.sourceSystem, externalId: shift.externalId,
        });
      }
    }
    return out.sort((a, b) => a.end.getTime() - b.end.getTime());
  }

  /**
   * Move the watermark, once the window has actually been scored.
   *
   * Never moved before the work, and never past a window that was skipped: a watermark
   * that runs ahead of the scoring turns a transient failure into a permanent gap that
   * nothing will ever go back for.
   */
  async markScored(tenantId: string, shiftId: string, through: Date): Promise<void> {
    // Inside the account's own session rather than spanning: the watermark belongs to
    // one customer, and a runner that writes across accounts by default is a runner
    // one bad identifier away from rewriting somebody else's.
    await withTenantId(this.ds, tenantId, (m) =>
      m.getRepository(EquipmentShift).update({ tenantId, id: shiftId }, { scoredThrough: through }));
  }

  private validate(input: ShiftInput): void {
    if (!input.name?.trim()) throw new BadRequestException('A shift needs a name.');
    if (!Number.isInteger(input.startMinute) || input.startMinute < 0 || input.startMinute > MINUTES_PER_DAY - 1) {
      throw new BadRequestException('The start has to be a minute of the day, 0 to 1439.');
    }
    if (!Number.isInteger(input.endMinute) || input.endMinute < 1 || input.endMinute > MINUTES_PER_DAY) {
      throw new BadRequestException('The end has to be a minute of the day, 1 to 1440.');
    }
    if (!input.days?.length) {
      throw new BadRequestException('A shift that runs on no days would never be scored.');
    }
    if (input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new BadRequestException('Days are 0 for Sunday through 6 for Saturday.');
    }
    if (new Set(input.days).size !== input.days.length) {
      throw new BadRequestException('That lists the same day twice.');
    }
    if (!isValidTimeZone(input.timeZone)) {
      throw new BadRequestException(
        `"${input.timeZone}" is not a timezone this can compute against. `
        + 'Use a region and city, such as Asia/Kolkata.',
      );
    }
    const length = nominalLengthMinutes(input as ShiftDefinition);
    if (length < MINIMUM_SHIFT_MINUTES) {
      throw new BadRequestException(
        `A shift of ${length} minutes is almost certainly a mistake. `
        + `The shortest this accepts is ${MINIMUM_SHIFT_MINUTES} minutes.`,
      );
    }
  }

  /**
   * Two shifts covering the same minute would score the same telemetry twice.
   *
   * Not a database constraint, because overlap between two rows on a circular week is
   * not something a unique index can express. Checked inside the transaction that is
   * about to write, which is where it can still say something useful.
   */
  private async assertNoOverlap(
    m: import('typeorm').EntityManager, scope: RequestScope, ref: EquipmentRef,
    candidate: ShiftInput, excludeId: string | null,
  ): Promise<void> {
    const existing = await m.getRepository(EquipmentShift).find({
      where: {
        tenantId: scope.tenantId, ...ref, status: 'active',
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
    });
    const clash = existing.find((other) =>
      shiftsOverlap(candidate as ShiftDefinition, other as ShiftDefinition));
    if (clash) {
      throw new ConflictException(
        `That overlaps the "${clash.name}" shift. Two shifts covering the same minute `
        + 'would score the same readings twice.',
      );
    }
  }
}
