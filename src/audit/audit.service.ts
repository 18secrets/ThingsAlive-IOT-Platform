import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { PlatformAccessLog } from './platform-access-log.entity';

export interface CrossTenantReadDetails {
  resource: string;
  reason: string;
  tenantIds: string[] | null;
}

export interface PlatformRouteRead {
  resource: string;
  method: string;
  path: string;
}

/**
 * Records platform-role access to tenant data (task P1-59).
 *
 * Two call sites, on purpose. The repository records a cross-tenant read at the
 * moment it happens, which is the precise event; the interceptor records the request
 * a platform role made, which catches reads that go through paths nobody thought to
 * instrument. Neither alone is complete.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(PlatformAccessLog) private readonly log: Repository<PlatformAccessLog>,
  ) {}

  /**
   * Fails the read if it cannot be recorded. That is the point of the control: a log
   * that silently stops writing is worse than no log, because it still reassures.
   */
  async recordCrossTenantRead(scope: RequestScope, details: CrossTenantReadDetails): Promise<void> {
    try {
      await this.log.save(
        this.log.create({
          actorUserId: scope.userId,
          actorRoles: [...scope.roles],
          tenantId: scope.tenantId,
          tenantIds: details.tenantIds,
          resource: details.resource,
          action: 'cross-tenant-read',
          reason: details.reason,
        }),
      );
    } catch (err) {
      this.logger.error(`Audit write failed; refusing the read. ${(err as Error).message}`);
      throw new ServiceUnavailableException('The access log is unavailable; the read was refused.');
    }
  }

  /**
   * The request-level record. Best effort by contrast: this one must not turn a
   * logging outage into an outage of every support screen, and the precise event —
   * the cross-tenant read above — already fails closed.
   */
  async recordRouteRead(scope: RequestScope, details: PlatformRouteRead): Promise<void> {
    try {
      await this.log.save(
        this.log.create({
          actorUserId: scope.userId,
          actorRoles: [...scope.roles],
          tenantId: scope.tenantId,
          tenantIds: null,
          resource: details.resource,
          action: 'read',
          reason: null,
          method: details.method,
          path: details.path,
        }),
      );
    } catch (err) {
      this.logger.error(`Route audit write failed: ${(err as Error).message}`);
    }
  }
}
