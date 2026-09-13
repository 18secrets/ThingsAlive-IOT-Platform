import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantId, withTenantSession } from '../../scope/tenant-session';
import { AppUser } from '../entities/app-user.entity';
import { TenantRole } from '../entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from '../entities/user-access.entity';
import { UserSession } from '../entities/user-session.entity';

export interface InviteInput {
  email: string;
  fullName: string;
  roleSlug: string;
  phone?: string | null;
  plants?: { sourceSystem: string; plantExternalId: string }[];
  equipment?: { sourceSystem: string; equipmentExternalId: string }[];
}

export interface UserView extends AppUser {
  plants: { sourceSystem: string; plantExternalId: string }[];
  equipment: { sourceSystem: string; equipmentExternalId: string }[];
}

/** Lower-cased and trimmed once, here, so a stray capital never creates a twin. */
export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

/**
 * The account's people (task P1-21).
 *
 * Inviting is one act that names a role, because a user without one is a user nobody
 * can describe: they can sign in and see nothing, and the first thing anybody does
 * with them is guess what they were supposed to be.
 *
 * An invited user has no password. Credentials and the login that uses them are the
 * next slice; until then this row is a record of who should exist, which is exactly
 * what the onboarding screens need to show.
 */
@Injectable()
export class UserService {
  constructor(private readonly ds: DataSource) {}

  async invite(scope: RequestScope, input: InviteInput, now = new Date()): Promise<UserView> {
    const email = normaliseEmail(input.email);
    if (!email.includes('@')) throw new BadRequestException('That is not an email address.');

    // Email identifies a person across the platform, so the uniqueness check has to
    // look past this account. It is the one read here that cannot be tenant-scoped,
    // and it deliberately reports nothing about where the clash is: "already in use"
    // is all a stranger's account owes anybody.
    const taken = await runTenantSpanning(this.ds, `invite uniqueness check by ${scope.userId}`, (m) =>
      m.getRepository(AppUser).findOne({ where: { email }, select: { id: true } }));
    if (taken) throw new ConflictException(`${email} already has a login.`);

    return withTenantSession(this.ds, scope, async (m) => {
      const role = await m.getRepository(TenantRole).findOne({
        where: { tenantId: scope.tenantId, slug: input.roleSlug },
      });
      if (!role) throw new NotFoundException(`No role "${input.roleSlug}" in this account.`);

      const repo = m.getRepository(AppUser);
      const user = await repo.save(repo.create({
        tenantId: scope.tenantId,
        email,
        fullName: input.fullName.trim(),
        phone: input.phone ?? null,
        roleSlug: role.slug,
        status: 'invited',
        passwordHash: null,
        externalUserId: null,
        externalSourceSystem: null,
        invitedBy: scope.userId,
        invitedAt: now,
        activatedAt: null,
        suspendedAt: null,
        suspendedReason: null,
      }));

      await this.writeAccess(m, scope, user.id, input);
      return this.view(m, scope.tenantId, user);
    });
  }

  async list(scope: RequestScope): Promise<UserView[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const users = await m.getRepository(AppUser).find({
        where: { tenantId: scope.tenantId },
        order: { fullName: 'ASC' },
      });
      return Promise.all(users.map((u) => this.view(m, scope.tenantId, u)));
    });
  }

  /**
   * Move somebody to a different role.
   *
   * The assignments do not move with them, deliberately. A site manager promoted to
   * CEO keeps rows pointing at three plants, and those rows stop mattering because
   * the new role's scope shape does not read them — but they are still there if the
   * promotion is reversed. Deleting them on every role change would quietly destroy
   * the record of what somebody used to run.
   */
  async setRole(scope: RequestScope, userId: string, roleSlug: string): Promise<UserView> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AppUser);
      const user = await repo.findOne({ where: { tenantId: scope.tenantId, id: userId } });
      if (!user) throw new NotFoundException('No such person in this account.');

      const role = await m.getRepository(TenantRole).findOne({
        where: { tenantId: scope.tenantId, slug: roleSlug },
      });
      if (!role) throw new NotFoundException(`No role "${roleSlug}" in this account.`);

      user.roleSlug = role.slug;
      return this.view(m, scope.tenantId, await repo.save(user));
    });
  }

  /**
   * Suspend rather than delete.
   *
   * Everything this person did — an activation, a threshold change, a work order —
   * names them. Removing the row would turn every one of those records into an
   * unresolvable id, which is how an audit trail stops being one.
   */
  async suspend(scope: RequestScope, userId: string, reason: string, now = new Date()): Promise<UserView> {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to suspend somebody.');
    }
    return this.setStatus(scope, userId, 'suspended', reason, now);
  }

  async reinstate(scope: RequestScope, userId: string, now = new Date()): Promise<UserView> {
    return this.setStatus(scope, userId, 'active', null, now);
  }

  private async setStatus(
    scope: RequestScope, userId: string, status: 'active' | 'suspended',
    reason: string | null, now: Date,
  ): Promise<UserView> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AppUser);
      const user = await repo.findOne({ where: { tenantId: scope.tenantId, id: userId } });
      if (!user) throw new NotFoundException('No such person in this account.');

      if (status === 'suspended') {
        user.status = 'suspended';
        user.suspendedAt = now;
        user.suspendedReason = reason;
      } else {
        // Somebody who never set a password goes back to invited, not active: the
        // invitation is still what is outstanding.
        user.status = user.passwordHash ? 'active' : 'invited';
        user.suspendedAt = null;
        user.suspendedReason = null;
      }
      return this.view(m, scope.tenantId, await repo.save(user));
    });
  }

  /** Replace this person's assignments wholesale. */
  async setAccess(
    scope: RequestScope, userId: string,
    input: Pick<InviteInput, 'plants' | 'equipment'>,
  ): Promise<UserView> {
    return withTenantSession(this.ds, scope, async (m) => {
      const user = await m.getRepository(AppUser).findOne({
        where: { tenantId: scope.tenantId, id: userId },
      });
      if (!user) throw new NotFoundException('No such person in this account.');

      await m.getRepository(UserPlantAccess).delete({ tenantId: scope.tenantId, userId });
      await m.getRepository(UserEquipmentAccess).delete({ tenantId: scope.tenantId, userId });
      await this.writeAccess(m, scope, userId, input);
      return this.view(m, scope.tenantId, user);
    });
  }

  /** The seeded first user of a new account, created by Things Alive. */
  async seedSuperAdmin(
    tenantId: string, input: { email: string; fullName: string }, by: string, now = new Date(),
  ): Promise<AppUser> {
    const email = normaliseEmail(input.email);
    return withTenantId(this.ds, tenantId, async (m) => {
      const repo = m.getRepository(AppUser);
      const existing = await repo.findOne({ where: { tenantId, email } });
      if (existing) return existing;

      return repo.save(repo.create({
        tenantId, email, fullName: input.fullName.trim(), phone: null,
        roleSlug: 'ceo-manager', status: 'invited', passwordHash: null,
        externalUserId: null, externalSourceSystem: null,
        invitedBy: by, invitedAt: now, activatedAt: null,
        suspendedAt: null, suspendedReason: null,
      }));
    });
  }

  private async writeAccess(
    m: import('typeorm').EntityManager, scope: RequestScope, userId: string,
    input: Pick<InviteInput, 'plants' | 'equipment'>,
  ): Promise<void> {
    const plants = m.getRepository(UserPlantAccess);
    for (const p of input.plants ?? []) {
      await plants.save(plants.create({
        tenantId: scope.tenantId, userId,
        sourceSystem: p.sourceSystem, plantExternalId: p.plantExternalId,
        grantedBy: scope.userId,
      }));
    }
    const equipment = m.getRepository(UserEquipmentAccess);
    for (const e of input.equipment ?? []) {
      await equipment.save(equipment.create({
        tenantId: scope.tenantId, userId,
        sourceSystem: e.sourceSystem, equipmentExternalId: e.equipmentExternalId,
        grantedBy: scope.userId,
      }));
    }
  }

  private async view(
    m: import('typeorm').EntityManager, tenantId: string, user: AppUser,
  ): Promise<UserView> {
    const plants = await m.getRepository(UserPlantAccess).find({
      where: { tenantId, userId: user.id }, order: { plantExternalId: 'ASC' },
    });
    const equipment = await m.getRepository(UserEquipmentAccess).find({
      where: { tenantId, userId: user.id }, order: { equipmentExternalId: 'ASC' },
    });
    return {
      ...user,
      plants: plants.map((p) => ({ sourceSystem: p.sourceSystem, plantExternalId: p.plantExternalId })),
      equipment: equipment.map((e) => ({ sourceSystem: e.sourceSystem, equipmentExternalId: e.equipmentExternalId })),
    };
  }
}
