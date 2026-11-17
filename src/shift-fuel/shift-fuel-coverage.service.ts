import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../equipment/equipment-profile.entity';
import { withTenantSession } from '../scope/tenant-session';
import { AccuracyQuery } from './shift-fuel-accuracy';

/**
 * Why a fuel-burning machine has no shift total, and so no forecast (D50's placement):
 * - `mirrored_from_1_0`: keyed by IoT Platform 1.0's row id, which is never matched to an
 *   equipment number.
 * - `no_shift_totals`: created in 2.0, but the existing platform sent no total for its
 *   number in the range — it is not synced there, or two accounts hold the number.
 */
export type NotCoveredReason = 'mirrored_from_1_0' | 'no_shift_totals';

export interface NotCoveredMachine {
  sourceSystem: string;
  externalId: string;
  name: string | null;
  reason: NotCoveredReason;
}

export interface ShiftFuelCoverage {
  from: string;
  to: string;
  asOf: string;
  /** Active machines with a fuel signal bound at some point in the range. */
  fuelled: number;
  /** Of those, the ones with at least one synced shift total in the range: what the accuracy page scores. */
  covered: number;
  notCovered: NotCoveredMachine[];
}

/** The signals that say a machine burns fuel and is measured doing it. */
const FUEL_SIGNALS = ['fuel_consumption', 'fuel_level'];

/**
 * Which fuel-burning machines the shift fuel forecast covers, and why the rest are not
 * (fuel test report FU-6, TC-FP-10). The tester found 3100092 burning 131.7 L on 3 Nov and
 * absent from the accuracy table, with nothing anywhere saying why: on Development it has
 * 2.0 readings and no total from the existing platform, so D50 had nothing to forecast it
 * from. Absent is now listed, with the reason.
 *
 * Its own route beside the accuracy one rather than a field on it: the accuracy answer is a
 * definition the user signed off (D53), and this is a question about which machines it is
 * an answer for.
 */
@Injectable()
export class ShiftFuelCoverageService {
  constructor(private readonly ds: DataSource) {}

  async coverage(scope: RequestScope, query: Pick<AccuracyQuery, 'from' | 'to'>, at: Date = new Date()): Promise<ShiftFuelCoverage> {
    const head = { from: query.from, to: query.to, asOf: at.toISOString() };
    if (scope.equipmentIds !== undefined && scope.equipmentIds.length === 0) {
      return { ...head, fuelled: 0, covered: 0, notCovered: [] };
    }
    const ids = scope.equipmentIds ? [...scope.equipmentIds] : null;
    return withTenantSession(this.ds, scope, async (m) => {
      // Bound at some point in the range, not now: a machine whose sensor came off
      // yesterday still burned fuel in last week's shifts.
      const fuelled: { source_system: string; external_id: string; name: string | null; covered: boolean }[] = await m.query(
        `SELECT p."source_system", p."external_id", p."name",
                EXISTS (SELECT 1 FROM "legacy_shift_metric" a
                         WHERE a."tenant_id" = p."tenant_id" AND a."source_system" = p."source_system"
                           AND a."external_id" = p."external_id" AND a."fuel_l" IS NOT NULL
                           AND a."sdate" BETWEEN $3::date AND $4::date) AS covered
           FROM "equipment_profile" p
          WHERE p."tenant_id" = $1 AND p."status" = 'active'
            AND ($5::text[] IS NULL OR p."external_id" = ANY($5::text[]))
            AND EXISTS (SELECT 1 FROM "signal_binding_version" b
                         WHERE b."tenant_id" = p."tenant_id" AND b."source_system" = p."source_system"
                           AND b."external_id" = p."external_id" AND b."signal_key" = ANY($2::text[])
                           -- Approved, now or then. A proposed or rejected binding is a
                           -- channel nobody agreed measures this machine's fuel.
                           AND b."status" IN ('active', 'superseded')
                           AND b."valid_from" < ($4::date + 1)::timestamptz
                           AND (b."valid_to" IS NULL OR b."valid_to" > $3::date::timestamptz))
          ORDER BY p."external_id", p."source_system"`,
        [scope.tenantId, FUEL_SIGNALS, query.from, query.to, ids],
      );
      return {
        ...head,
        fuelled: fuelled.length,
        covered: fuelled.filter((f) => f.covered).length,
        notCovered: fuelled.filter((f) => !f.covered).map((f) => ({
          sourceSystem: f.source_system, externalId: f.external_id, name: f.name,
          reason: f.source_system === CLIENT_SOURCE_SYSTEM ? 'no_shift_totals' : 'mirrored_from_1_0',
        })),
      };
    });
  }
}
