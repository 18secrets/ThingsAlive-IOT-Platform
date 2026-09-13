import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ResolvedIdentity, ScopeResolver } from '../../auth/scope-resolver';
import { withTenantId } from '../../scope/tenant-session';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { Plant } from '../../equipment/entities/plant.entity';
import { EquipmentProjection } from '../../projection/entities/equipment-projection.entity';
import { Tenant } from '../../tenancy/entities/tenant.entity';
import { AppUser } from '../entities/app-user.entity';
import { TenantRole } from '../entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from '../entities/user-access.entity';

/**
 * Turning a signed-in person into the authority for one request (task P1-84).
 *
 * Resolved from 2.0's own tables on every request rather than read from the token.
 * That is what makes taking access away take effect immediately: a suspension, a role
 * change or a removed assignment applies to the next request, not to the next token.
 *
 * The three scope shapes are resolved differently on purpose, and the difference
 * between an empty list and no list carries the meaning: `undefined` is unrestricted
 * within the account, `[]` matches nothing. A site manager assigned to no sites sees
 * nothing, which is correct and is not the same as seeing everything.
 */
@Injectable()
export class ScopeResolverService implements ScopeResolver {
  private readonly logger = new Logger(ScopeResolverService.name);

  constructor(private readonly ds: DataSource) {}

  async resolve(tenantId: string, userId: string): Promise<ResolvedIdentity | null> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const user = await m.getRepository(AppUser).findOne({ where: { tenantId, id: userId } });
      // Not a user of this account. Returning null lets the guard fall back to the
      // token, which is what a platform role needs — Things Alive staff have no row
      // in any customer's account and must not be invented one.
      if (!user) return null;

      // The account before the person. Suspending a whole account is the commercial
      // lever — non-payment, a contract ending — and it has to stop everybody at once
      // without anybody having to edit a single user record.
      const tenant = await m.getRepository(Tenant).findOne({ where: { tenantId } });
      if (tenant && tenant.status === 'suspended') {
        throw new UnauthorizedException(
          'This organisation\'s account is suspended. Please contact Things Alive.',
        );
      }

      if (user.status === 'suspended') {
        throw new UnauthorizedException('This account has been suspended.');
      }
      if (user.status === 'invited') {
        throw new UnauthorizedException('This invitation has not been accepted yet.');
      }

      const role = await m.getRepository(TenantRole).findOne({
        where: { tenantId, slug: user.roleSlug },
      });
      // A role that has gone missing is a refusal, not a fallback. Treating it as
      // "no capabilities" would look identical to a correctly locked-down user and
      // hide a broken account for as long as nobody complained loudly.
      if (!role) {
        throw new UnauthorizedException(
          `Your role "${user.roleSlug}" no longer exists in this account. An administrator has to reassign it.`,
        );
      }

      if (role.scopeShape === 'tenant') {
        return {
          roles: [role.slug],
          capabilities: role.capabilities,
          plantIds: undefined,
          equipmentIds: undefined,
        };
      }

      if (role.scopeShape === 'plant') {
        const rows = await m.getRepository(UserPlantAccess).find({ where: { tenantId, userId } });
        const plantIds = rows.map((r) => r.plantExternalId);
        // Equipment is derived rather than stored. A machine moved into one of this
        // person's sites is theirs from that moment, and a list maintained by hand
        // would have to be rewritten every time anything moved.
        const equipmentIds = plantIds.length
          ? (await m.getRepository(EquipmentProjection).find({
              where: { tenantId, plantExternalId: In(plantIds) },
              select: { externalId: true },
            })).map((e) => e.externalId)
          : [];
        return { roles: [role.slug], capabilities: role.capabilities, plantIds, equipmentIds };
      }

      const rows = await m.getRepository(UserEquipmentAccess).find({ where: { tenantId, userId } });
      const equipmentIds = rows.map((r) => r.equipmentExternalId);
      // No plant-level access at all: an operator sees machines, not sites. An empty
      // list rather than undefined, because undefined here would mean every site.
      return { roles: [role.slug], capabilities: role.capabilities, plantIds: [], equipmentIds };
    });
  }
}
