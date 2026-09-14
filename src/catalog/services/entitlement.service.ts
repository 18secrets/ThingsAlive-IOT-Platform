import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { CopyOnGrantService } from '../../client-catalog/services/copy-on-grant.service';
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
    private readonly copies: CopyOnGrantService,
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

    // Checked before the grant row is written, not after. A grant is now two writes —
    // the entitlement, and the copy into the client's account — and failing between
    // them would leave an account holding an entitlement with no catalog behind it,
    // which is a state the product has no screen for and no way to reach deliberately.
    //
    // They are not one transaction because they are not one tenant: the entitlement is
    // platform-owned and the copy runs inside the client's own session. Refusing early
    // removes the only failure anybody is likely to cause.
    const publishable = await this.classes.findOne({
      where: { slug: equipmentClassSlug, status: 'published' },
    });
    if (!publishable) {
      throw new BadRequestException(
        `"${equipmentClassSlug}" has no published version. Publish it before granting it — `
        + 'a client cannot be given a copy of something that does not exist yet.',
      );
    }

    const existing = await this.grants.findOne({ where: { tenantId, equipmentClassSlug } });
    if (existing) {
      // Re-granting is how a revoked entitlement comes back. Reusing the row keeps
      // one history per tenant and class rather than a pile of near-duplicates.
      existing.revokedAt = null;
      existing.revokedBy = null;
      existing.grantedBy = scope.userId;
      if (note !== undefined) existing.note = note;
      const restored = await this.grants.save(existing);
      // Their copy may still be there from last time, edited. copyForTenant leaves an
      // existing copy alone, so re-granting restores access without undoing their work.
      await this.copies.copyForTenant(tenantId, equipmentClassSlug, scope.userId);
      return restored;
    }

    this.logger.log(`Granting "${equipmentClassSlug}" to tenant ${tenantId} by ${scope.userId}.`);
    const grant = await this.grants.save(
      this.grants.create({ tenantId, equipmentClassSlug, grantedBy: scope.userId, note: note ?? null }),
    );

    // The grant is also the moment ownership transfers. The class and its published
    // scenarios are copied into the client's account, and from here the copies are
    // theirs: their super admin may rewrite them and nobody at Things Alive can.
    //
    // The copy never overwrites one the client already has, so re-granting after a
    // revocation restores access without undoing whatever they had changed.
    await this.copies.copyForTenant(tenantId, equipmentClassSlug, scope.userId);
    return grant;
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
