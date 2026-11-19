import { Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { withTenantId } from '../scope/tenant-session';
import { HealthScore } from './health-score';
import { healthIn, healthKey } from './machine-health';

@Injectable()
export class MachineHealthService {
  constructor(private readonly ds: DataSource) {}

  /**
   * One machine's health score, as the caller may see it. A machine outside the
   * caller's machines is "not found", the same answer as one that does not exist, so
   * the endpoint cannot be used to learn which machines an account has.
   */
  async forMachine(
    scope: RequestScope, sourceSystem: string, externalId: string, onBehalfOfTenantId?: string,
  ): Promise<HealthScore & { sourceSystem: string; externalId: string }> {
    if (onBehalfOfTenantId && !scope.isPlatformRole) {
      throw new ForbiddenException('Only Things Alive staff can read another account\'s machines.');
    }
    const tenantId = onBehalfOfTenantId || scope.tenantId;
    const notFound = () => new NotFoundException(`No machine ${sourceSystem}/${externalId} here.`);
    if (!onBehalfOfTenantId && scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) throw notFound();
    return withTenantId(this.ds, tenantId, async (m) => {
      const [exists] = await m.query(
        `SELECT 1 FROM "equipment_profile" WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3`,
        [tenantId, sourceSystem, externalId]);
      if (!exists) throw notFound();
      const scores = await healthIn(m, tenantId, [{ sourceSystem, externalId }]);
      return { sourceSystem, externalId, ...scores.get(healthKey({ sourceSystem, externalId }))! };
    });
  }
}

/**
 * A machine's health score (D63): 0–100 with every deduction and its reason, or
 * `unknown` with why. Read like a prediction — it is one more way the platform says how
 * a machine is doing — so it takes `prediction.read`.
 */
@ApiTags('Machine health')
@Controller('equipment')
export class MachineHealthController {
  constructor(private readonly health: MachineHealthService) {}

  @Get(':sourceSystem/:externalId/health')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'A machine\'s health score: 0–100 with each deduction and its reason, or unknown with why' })
  get(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.health.forMachine(scope, sourceSystem, externalId, tenantId);
  }
}
