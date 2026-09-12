import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ScenarioActivationEvent } from '../entities/scenario-activation-event.entity';

/**
 * The client's readable history of activations (task P1-09).
 *
 * Newest first, because the question is almost always about the most recent change.
 */
@Injectable()
export class ActivationHistoryService {
  constructor(private readonly ds: DataSource) {}

  forAsset(
    scope: RequestScope, sourceSystem: string, externalId: string, limit = 100,
  ): Promise<ScenarioActivationEvent[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(ScenarioActivationEvent).find({
        where: { tenantId: scope.tenantId, sourceSystem, externalId },
        order: { at: 'DESC' },
        take: limit,
      }),
    );
  }

  forScenario(
    scope: RequestScope, clientScenarioSlug: string, limit = 100,
  ): Promise<ScenarioActivationEvent[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(ScenarioActivationEvent).find({
        where: { tenantId: scope.tenantId, clientScenarioSlug },
        order: { at: 'DESC' },
        take: limit,
      }),
    );
  }
}
