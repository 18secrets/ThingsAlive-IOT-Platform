import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { ClientCatalogEntitlement } from '../entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';

/**
 * Grants and revocations, written by a master admin (task P1-04).
 *
 * This table is the commercial boundary: it decides what a customer can see and
 * activate. It is deliberately not tenant-owned — a tenant that could write its own
 * entitlements would be deciding what it had bought.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    @InjectRepository(ClientCatalogEntitlement)
    private readonly grants: Repository<ClientCatalogEntitlement>,
    @InjectRepository(EquipmentClassProfile)
    private readonly classes: Repository<EquipmentClassProfile>,
  ) {}

  list(_scope: RequestScope): Promise<ClientCatalogEntitlement[]> {
    return this.grants.find({ order: { tenantId: 'ASC', equipmentClassSlug: 'ASC' } });
  }

  async grant(
    scope: RequestScope,
    tenantId: string,
    equipmentClassSlug: string,
    note?: string,
  ): Promise<ClientCatalogEntitlement> {
    // A grant for a class that does not exist is almost always a typo in a slug, and
    // it would sit there looking like a working entitlement until somebody wondered
    // why the customer's catalog was empty.
    const known = await this.classes.findOne({ where: { slug: equipmentClassSlug } });
    if (!known) throw new BadRequestException(`No equipment class "${equipmentClassSlug}" to grant.`);

    const existing = await this.grants.findOne({ where: { tenantId, equipmentClassSlug } });
    if (existing) {
      // Re-granting is how a revoked entitlement comes back. Reusing the row keeps
      // one history per tenant and class rather than a pile of near-duplicates.
      existing.revokedAt = null;
      existing.revokedBy = null;
      existing.grantedBy = scope.userId;
      if (note !== undefined) existing.note = note;
      return this.grants.save(existing);
    }

    this.logger.log(`Granting "${equipmentClassSlug}" to tenant ${tenantId} by ${scope.userId}.`);
    return this.grants.save(
      this.grants.create({ tenantId, equipmentClassSlug, grantedBy: scope.userId, note: note ?? null }),
    );
  }

  async revoke(scope: RequestScope, id: string): Promise<ClientCatalogEntitlement> {
    const row = await this.grants.findOne({ where: { id, revokedAt: IsNull() } });
    if (!row) throw new NotFoundException('No active grant with that id.');
    row.revokedAt = new Date();
    row.revokedBy = scope.userId;
    this.logger.warn(`Revoking "${row.equipmentClassSlug}" from tenant ${row.tenantId}.`);
    return this.grants.save(row);
  }
}
