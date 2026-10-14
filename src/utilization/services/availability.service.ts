import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { WindowReading } from '../../alert/services/alert-rules';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../../kpi/services/telemetry-window-reader';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { EquipmentShift } from '../../shift/entities/equipment-shift.entity';
import {
  aggregateAvailability, Availability, AVAILABILITY_SIGNALS, computeAvailability,
  FleetAvailability, Period,
} from './availability';

export interface EquipmentAvailability extends Availability {
  sourceSystem: string;
  externalId: string;
}

/**
 * Reads what availability needs and hands it to the pure computation (task QAVAIL1).
 *
 * It reads the local `telemetry_reading` copy, not the legacy backend: an endpoint
 * that pulled upstream on every request would put the customer's screen on the far
 * side of somebody else's database. Shifts are read live from `equipment_shift`
 * rather than from the `utilization_shift` rows the runner wrote, because those rows
 * are one total per whole window — they cannot answer a period that cuts a shift in
 * half, and they say nothing about running outside a shift.
 */
@Injectable()
export class AvailabilityService {
  private readonly telemetry = new TelemetryWindowReader();

  constructor(private readonly ds: DataSource) {}

  async forEquipment(
    scope: RequestScope, ref: { sourceSystem: string; externalId: string }, period: Period,
  ): Promise<EquipmentAvailability> {
    // Out of scope reads as absent, not forbidden: whether a machine exists in an
    // account is itself something an operator outside it should not learn.
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      });
      if (!profile) throw new NotFoundException('No such equipment in this account.');
      const [result] = await this.measure(m, scope.tenantId, [profile], period);
      return result;
    });
  }

  /**
   * Every active machine the caller may see. Retired machines are left out: a machine
   * taken out of service is not unavailable, and counting it would make a fleet look
   * worse for having retired something.
   */
  async forFleet(
    scope: RequestScope, period: Period,
  ): Promise<FleetAvailability & { machines: EquipmentAvailability[] }> {
    return withTenantSession(this.ds, scope, async (m) => {
      const qb = m.getRepository(EquipmentProfile).createQueryBuilder('e')
        .where('e.tenant_id = :tenantId', { tenantId: scope.tenantId })
        .andWhere(`e.status = 'active'`);
      // Undefined is unrestricted, [] matches nothing. The same rule everywhere.
      if (scope.equipmentIds !== undefined) {
        qb.andWhere('e.external_id = ANY(:ids)', { ids: [...scope.equipmentIds] });
      }
      const profiles = await qb.orderBy('e.external_id', 'ASC').getMany();
      const machines = await this.measure(m, scope.tenantId, profiles, period);
      return { ...aggregateAvailability(machines), machines };
    });
  }

  private async measure(
    m: EntityManager, tenantId: string, profiles: EquipmentProfile[], period: Period,
  ): Promise<EquipmentAvailability[]> {
    if (!profiles.length) return [];
    const externalIds = profiles.map((p) => p.externalId);

    const [shifts, devices] = await Promise.all([
      m.getRepository(EquipmentShift).find({
        where: { tenantId, externalId: In(externalIds), status: 'active' },
      }),
      m.getRepository(DeviceProjection).find({
        where: { tenantId, equipmentExternalId: In(externalIds) },
      }),
    ]);

    const out: EquipmentAvailability[] = [];
    for (const p of profiles) {
      const mine = (row: { sourceSystem: string }) => row.sourceSystem === p.sourceSystem;
      const machineShifts = shifts.filter((s) => s.externalId === p.externalId && mine(s));
      const imeis = [...new Set(devices
        .filter((d) => d.equipmentExternalId === p.externalId && mine(d))
        .map((d) => d.imei))];
      const readings = await readEngineState(this.telemetry, m, tenantId, imeis, period);

      out.push({
        sourceSystem: p.sourceSystem,
        externalId: p.externalId,
        ...computeAvailability(machineShifts, readings, period),
      });
    }
    return out;
  }
}

/**
 * The engine-state readings Availability measures from, for a machine's devices over a
 * period. Exported so OEE (task QOEE1) reads exactly the minutes Availability does: its
 * Performance divides Availability's numerator, and two reads of "was it on" would let
 * the chain's denominators disagree.
 */
export async function readEngineState(
  reader: TelemetryWindowReader, m: EntityManager, tenantId: string, imeis: string[], period: Period,
): Promise<WindowReading[]> {
  const bySignal = await reader.read(m, tenantId, imeis, [...AVAILABILITY_SIGNALS], period.from, period.to);
  const readings: WindowReading[] = [];
  for (const [signal, rows] of bySignal) {
    for (const r of rows) readings.push({ signal, value: r.value, sourceTimestamp: r.at.toISOString() });
  }
  return readings;
}
