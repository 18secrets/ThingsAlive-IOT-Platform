import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentClassProfile } from '../catalog/entities/equipment-class-profile.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { EquipmentRef } from '../kpi/types';
import { withTenantSession } from '../scope/tenant-session';
import { EquipmentShift } from '../shift/entities/equipment-shift.entity';
import { windowsEndingBetween } from '../shift/services/shift-window';
import { ClassFuelFigures, ExpectedFuel, expectedShiftFuel } from './expected-fuel';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One upcoming shift of one machine and what it should burn. */
export interface ExpectedShift extends ExpectedFuel {
  shiftName: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface MachineExpectedFuel {
  equipment: EquipmentRef;
  asOf: string;
  /** The class version the figures were read at — the one the machine is on. */
  equipmentClass: { slug: string; version: number; name: string } | null;
  /** The shift under way (if any) and the next one; one blocked entry when there is no schedule. */
  shifts: ExpectedShift[];
}

/**
 * Expected litres for a machine's current and next shift, from its class's figures and its
 * own schedule (fuel test report TC-FP-07/-09/-11). Computed on request and stored nowhere:
 * it reads only the library and the schedule, so it is the same answer every time for the
 * same inputs, and storing it would make a second copy of figures that already have one.
 * D50's history forecast is unchanged and sits beside it, scored; this one is what a machine
 * has before it has a history.
 */
@Injectable()
export class ExpectedFuelApiService {
  constructor(private readonly ds: DataSource) {}

  async machine(scope: RequestScope, ref: EquipmentRef, at: Date = new Date()): Promise<MachineExpectedFuel> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      });
      if (!profile) throw new NotFoundException('No such equipment in this account.');

      // The version the machine is on, not the newest: that is what was granted, and the
      // nominal OEE shows is read at the same one.
      const klass = profile.equipmentClassSlug && profile.classVersion
        ? await m.getRepository(EquipmentClassProfile).findOne({
            where: { slug: profile.equipmentClassSlug, version: profile.classVersion },
          })
        : null;
      const figures = klass ? figuresOf(klass) : null;

      const shifts = await m.getRepository(EquipmentShift).find({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId, status: 'active' },
      });
      const upcoming = shifts
        // Every instance ending in the next three days, from a day back so the one under
        // way now is among them; then the first two that have not ended.
        .flatMap((s) => windowsEndingBetween(s, new Date(at.getTime() - DAY_MS), new Date(at.getTime() + 3 * DAY_MS))
          .map((w) => ({ name: s.name, start: w.start, end: w.end })))
        .filter((w) => w.end.getTime() > at.getTime())
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .slice(0, 2);

      const out: ExpectedShift[] = upcoming.length
        ? upcoming.map((w) => ({
            shiftName: w.name, startsAt: w.start.toISOString(), endsAt: w.end.toISOString(),
            ...expectedShiftFuel(figures, (w.end.getTime() - w.start.getTime()) / HOUR_MS),
          }))
        : [{ shiftName: null, startsAt: null, endsAt: null, ...expectedShiftFuel(figures, null) }];

      return {
        equipment: { sourceSystem: ref.sourceSystem, externalId: ref.externalId },
        asOf: at.toISOString(),
        equipmentClass: klass ? { slug: klass.slug, version: klass.version, name: klass.name } : null,
        shifts: out,
      };
    });
  }
}

function figuresOf(c: EquipmentClassProfile): ClassFuelFigures {
  return {
    classSlug: c.slug, classVersion: c.version, className: c.name,
    nominalFuelPerHour: c.nominalFuelPerHour, nominalFuelUnit: c.nominalFuelUnit, nominalFuelSource: c.nominalFuelSource,
    ratedPowerKw: c.ratedPowerKw, workingLoadPct: c.workingLoadPct, bsfcGPerKwh: c.bsfcGPerKwh, bsfcSource: c.bsfcSource,
    idleFuelPerHour: c.idleFuelPerHour, workingShare: c.workingShare,
  };
}
