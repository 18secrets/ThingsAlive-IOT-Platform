import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ShiftRun } from '../entities/shift-run.entity';

/**
 * Reading back what the runner did (task P1-115).
 *
 * Separate from the runner, because writing a ledger and answering questions from it
 * are different jobs with different callers: one has no request behind it, and this
 * one is always somebody asking about their own machine.
 */
@Injectable()
export class ShiftRunService {
  constructor(private readonly ds: DataSource) {}

  async forEquipment(
    scope: RequestScope, ref: { sourceSystem: string; externalId: string }, take = 50,
  ): Promise<ShiftRun[]> {
    // Undefined is unrestricted, [] matches nothing. The same rule everywhere.
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      return [];
    }
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(ShiftRun).find({
        where: { tenantId: scope.tenantId, ...ref },
        order: { ranAt: 'DESC' },
        take,
      }));
  }
}
