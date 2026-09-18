import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning } from '../../scope/tenant-session';
import { DomainEvent } from '../../events/domain-event.entity';
import { AppUser, UserStatus } from '../../identity/entities/app-user.entity';
import { TenantRole } from '../../identity/entities/tenant-role.entity';
import { UserInvitation } from '../../identity/entities/user-invitation.entity';
import { ROLE_TEMPLATES } from '../../identity/role-templates';
import { PasswordService } from '../../identity/services/password.service';
import { TenantMap } from '../../projection/entities/tenant-map.entity';
import { Tenant } from '../entities/tenant.entity';

export interface ProvisionInput {
  tenantId: string;
  name: string;
  plan?: string | null;
  region?: string | null;
  /** The first person, who becomes the account's own administrator. */
  superAdmin: { email: string; fullName: string; phone?: string | null };
  /** Optional: the upstream client identifiers whose data belongs to this account. */
  externalClients?: { sourceSystem: string; externalClientId: string }[];
}

/** The one person a freshly provisioned account has — shown alongside the tenant
 *  itself wherever the account is listed, since a commercial account with nobody's
 *  name or number attached to it is not something anyone can act on. */
export interface SuperAdminContact {
  fullName: string;
  email: string;
  phone: string | null;
  /** 'invited' until they accept and set a password — the first-login signal the
   *  console shows as "Awaiting First Login" vs "Password Set". */
  status: UserStatus;
}

export interface UpdateInput {
  name?: string;
  plan?: string | null;
  region?: string | null;
  superAdmin?: { fullName?: string; email?: string; phone?: string | null };
}

export interface ProvisionResult {
  tenant: Tenant;
  roles: string[];
  superAdmin: { id: string; email: string };
  /** Returned once, for the email this platform does not yet send. */
  invitationToken: string;
  invitationExpiresAt: Date;
  alreadyExisted: boolean;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Standing an account up, in one transaction (task P1-89).
 *
 * Five writes that have to happen together: the account, its upstream identifier
 * mapping, its three roles, its first administrator, and that person's invitation.
 * Everything here already existed separately; what this adds is the guarantee that
 * they either all happen or none do.
 *
 * That guarantee is the whole feature. A half-provisioned account is the worst of
 * the three possible outcomes — worse than a failure, because it exists, nobody can
 * get into it, and the person re-running the step cannot tell what is already there.
 * Failing cleanly leaves nothing to reason about.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly passwords: PasswordService,
  ) {}

  async provision(
    scope: RequestScope, input: ProvisionInput, now = new Date(),
  ): Promise<ProvisionResult> {
    this.requirePlatform(scope);
    const tenantId = input.tenantId.trim();

    // Checked before anything is written, and checked as typed rather than after
    // being tidied up. A tenant id appears in every row of every table and inside the
    // row-level-security predicate itself, so it is the one identifier here that can
    // never be corrected later — which makes silently accepting "Acme" and storing
    // "acme" the wrong kindness. Whoever types it goes on to reference it in an
    // integration, and the mismatch surfaces as data that never arrives.
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new BadRequestException(
        `"${input.tenantId}" cannot be a tenant id. It must be lower-case letters, digits `
        + 'and hyphens, 2 to 63 characters, starting with a letter or digit — and it is not '
        + 'corrected for you, because it can never be changed afterwards.',
      );
    }
    const email = input.superAdmin.email.trim().toLowerCase();
    if (!email.includes('@')) throw new BadRequestException('That is not an email address.');

    return runTenantSpanning(this.ds, `provision ${tenantId} by ${scope.userId}`, async (m) => {
      const existing = await m.getRepository(Tenant).findOne({ where: { tenantId } });
      if (existing) {
        // Re-running provisioning is how somebody recovers from a failure, so it is
        // not an error — but it also must not quietly hand back a second invitation
        // to an account that is already live, because that is a working credential
        // for somebody who may no longer be entitled to one.
        throw new ConflictException(
          `An account "${tenantId}" already exists. Invite people to it rather than provisioning it again.`,
        );
      }

      // Email is unique platform-wide, and finding out after the account exists would
      // leave exactly the half-provisioned state this transaction is here to prevent.
      const taken = await m.getRepository(AppUser).findOne({ where: { email }, select: { id: true } });
      if (taken) throw new ConflictException(`${email} already has a login.`);

      const tenant = await this.createTenant(m, scope, tenantId, input, now);
      await this.mapExternalClients(m, tenantId, input, now);
      const roles = await this.copyRoleTemplates(m, tenantId, scope.userId, now);
      const admin = await this.seedSuperAdmin(
        m, tenantId, email, input.superAdmin.fullName, input.superAdmin.phone ?? null, scope.userId, now,
      );
      const invitation = await this.inviteSuperAdmin(m, tenant, admin, scope.userId, now);

      await this.announce(m, tenant, admin, now);

      return {
        tenant,
        roles: roles.map((r) => r.slug),
        superAdmin: { id: admin.id, email: admin.email },
        invitationToken: invitation.token,
        invitationExpiresAt: invitation.expiresAt,
        alreadyExisted: false,
      };
    });
  }

  /** Turn an account off. Every sign-in stops; nothing about any user changes. */
  async suspend(
    scope: RequestScope, tenantId: string, reason: string, now = new Date(),
  ): Promise<Tenant & { superAdmin: SuperAdminContact | null }> {
    this.requirePlatform(scope);
    if (!reason?.trim()) {
      throw new BadRequestException(
        'A reason is required to suspend an account. Somebody will ask why their fleet went dark.',
      );
    }
    return this.setStatus(scope, tenantId, 'suspended', reason, now);
  }

  async reinstate(
    scope: RequestScope, tenantId: string, now = new Date(),
  ): Promise<Tenant & { superAdmin: SuperAdminContact | null }> {
    this.requirePlatform(scope);
    return this.setStatus(scope, tenantId, 'active', null, now);
  }

  async list(scope: RequestScope): Promise<(Tenant & { superAdmin: SuperAdminContact | null })[]> {
    this.requirePlatform(scope);
    return runTenantSpanning(this.ds, `tenant list by ${scope.userId}`, async (m) => {
      const tenants = await m.getRepository(Tenant).find({ order: { name: 'ASC' } });
      const admins = await this.superAdminsFor(m, tenants.map((t) => t.tenantId));
      return tenants.map((t) => ({ ...t, superAdmin: admins.get(t.tenantId) ?? null }));
    });
  }

  async get(scope: RequestScope, tenantId: string): Promise<Tenant & { superAdmin: SuperAdminContact | null }> {
    this.requirePlatform(scope);
    return runTenantSpanning(this.ds, `tenant read by ${scope.userId}`, async (m) => {
      const tenant = await m.getRepository(Tenant).findOne({ where: { tenantId } });
      if (!tenant) throw new NotFoundException(`No account "${tenantId}".`);
      const admins = await this.superAdminsFor(m, [tenantId]);
      return { ...tenant, superAdmin: admins.get(tenantId) ?? null };
    });
  }

  /**
   * The `ceo-manager` on each account — its slug never moves once provisioned (see
   * IdentityController's own comment on renaming a role), so it is a stable way to
   * find "the" super admin without a dedicated flag anywhere. If a tenant ever ends
   * up with more than one, the earliest is shown; a second super admin does not
   * change who the account was provisioned for.
   */
  private async superAdminsFor(m: EntityManager, tenantIds: string[]): Promise<Map<string, SuperAdminContact>> {
    if (tenantIds.length === 0) return new Map();
    const admins = await m.getRepository(AppUser).find({
      where: tenantIds.map((tenantId) => ({ tenantId, roleSlug: 'ceo-manager' })),
      order: { createdAt: 'ASC' },
    });
    const byTenant = new Map<string, SuperAdminContact>();
    for (const admin of admins) {
      if (byTenant.has(admin.tenantId)) continue;
      byTenant.set(admin.tenantId, {
        fullName: admin.fullName, email: admin.email, phone: admin.phone, status: admin.status,
      });
    }
    return byTenant;
  }

  /**
   * Renaming the account, or correcting its super admin's own contact details.
   *
   * Not everything is editable here on purpose: `tenantId` never moves (it is inside
   * every row-level-security predicate this account owns), and there is no way to
   * move the super admin role to a different person — that is `PUT
   * /identity/users/:id/role`, inside the account's own session, because who holds
   * that role is the client's decision, not something Things Alive corrects for them.
   */
  async update(
    scope: RequestScope, tenantId: string, input: UpdateInput,
  ): Promise<Tenant & { superAdmin: SuperAdminContact | null }> {
    this.requirePlatform(scope);
    return runTenantSpanning(this.ds, `tenant update: ${tenantId} by ${scope.userId}`, async (m) => {
      const tenant = await m.getRepository(Tenant).findOne({ where: { tenantId } });
      if (!tenant) throw new NotFoundException(`No account "${tenantId}".`);

      if (input.name !== undefined) tenant.name = input.name.trim();
      if (input.plan !== undefined) tenant.plan = input.plan;
      if (input.region !== undefined) tenant.region = input.region;
      await m.getRepository(Tenant).save(tenant);

      let superAdmin: SuperAdminContact | null = (await this.superAdminsFor(m, [tenantId])).get(tenantId) ?? null;

      if (input.superAdmin) {
        const users = m.getRepository(AppUser);
        const admin = await users.findOne({ where: { tenantId, roleSlug: 'ceo-manager' } });
        if (!admin) {
          throw new NotFoundException(
            `"${tenantId}" has no super admin to update — it may have been reassigned to a different role.`,
          );
        }
        if (input.superAdmin.fullName !== undefined) admin.fullName = input.superAdmin.fullName.trim();
        if (input.superAdmin.phone !== undefined) admin.phone = input.superAdmin.phone?.trim() || null;
        if (input.superAdmin.email !== undefined) {
          const email = input.superAdmin.email.trim().toLowerCase();
          if (email !== admin.email) {
            const taken = await users.findOne({ where: { email }, select: { id: true } });
            if (taken) throw new ConflictException(`${email} already has a login.`);
            admin.email = email;
          }
        }
        await users.save(admin);
        superAdmin = { fullName: admin.fullName, email: admin.email, phone: admin.phone, status: admin.status };
      }

      return { ...tenant, superAdmin };
    });
  }

  /**
   * A second copy of the same invitation, for when the first one is lost before
   * anybody used it. Only works while the super admin has never set a password —
   * once they have, this is not how they get back in (that is
   * `POST /auth/forgot-password`, self-service, because by then only they should
   * be able to trigger a reset on their own credential).
   *
   * Outstanding invite tokens are retired first, the same rule `CredentialService`
   * follows: two live invitations means the older one still works, which defeats
   * the point of replacing it.
   */
  async resendInvitation(
    scope: RequestScope, tenantId: string, now = new Date(),
  ): Promise<{ email: string; invitationToken: string; invitationExpiresAt: Date }> {
    this.requirePlatform(scope);
    return runTenantSpanning(this.ds, `resend invitation: ${tenantId} by ${scope.userId}`, async (m) => {
      const admin = await m.getRepository(AppUser).findOne({ where: { tenantId, roleSlug: 'ceo-manager' } });
      if (!admin) throw new NotFoundException(`"${tenantId}" has no super admin to invite.`);
      if (admin.status !== 'invited') {
        throw new BadRequestException(
          `${admin.email} already has a password set. Resending an invitation would not help — `
          + 'they need "forgot password" instead.',
        );
      }

      const invitations = m.getRepository(UserInvitation);
      await invitations.update(
        { tenantId, userId: admin.id, purpose: 'invite', consumedAt: IsNull() },
        { consumedAt: now },
      );
      const invitationToken = this.passwords.newToken();
      const invitationExpiresAt = new Date(now.getTime() + 14 * 86_400_000);
      await invitations.save(invitations.create({
        tenantId, userId: admin.id,
        tokenHash: this.passwords.fingerprint(invitationToken),
        purpose: 'invite', expiresAt: invitationExpiresAt, consumedAt: null, createdBy: scope.userId,
      }));
      return { email: admin.email, invitationToken, invitationExpiresAt };
    });
  }

  // ----------------------------------------------------------------------- pieces

  private async createTenant(
    m: EntityManager, scope: RequestScope, tenantId: string, input: ProvisionInput, now: Date,
  ): Promise<Tenant> {
    const repo = m.getRepository(Tenant);
    return repo.save(repo.create({
      tenantId,
      name: input.name.trim(),
      status: 'active',
      plan: input.plan ?? null,
      region: input.region ?? null,
      suspendedAt: null,
      suspendedReason: null,
      provisionedBy: scope.userId,
    }));
  }

  private async mapExternalClients(
    m: EntityManager, tenantId: string, input: ProvisionInput, now: Date,
  ): Promise<void> {
    const repo = m.getRepository(TenantMap);
    for (const ref of input.externalClients ?? []) {
      // The projection sync refuses any record whose client does not resolve here, so
      // without this the account exists and its machines arrive as rejections.
      const clash = await repo.findOne({
        where: { sourceSystem: ref.sourceSystem, externalClientId: ref.externalClientId },
      });
      if (clash && clash.tenantId !== tenantId) {
        throw new ConflictException(
          `Client "${ref.externalClientId}" on ${ref.sourceSystem} already belongs to another account. `
          + 'Two accounts claiming one upstream client would each receive half its data.',
        );
      }
      if (clash) continue;
      await repo.save(repo.create({ ...ref, tenantId, displayName: input.name.trim() }));
    }
  }

  private async copyRoleTemplates(
    m: EntityManager, tenantId: string, by: string, now: Date,
  ): Promise<TenantRole[]> {
    const repo = m.getRepository(TenantRole);
    const out: TenantRole[] = [];
    for (const template of ROLE_TEMPLATES) {
      out.push(await repo.save(repo.create({
        tenantId,
        slug: template.slug,
        name: template.name,
        description: template.description,
        capabilities: [...template.capabilities],
        scopeShape: template.scopeShape,
        allowedTabs: [...template.allowedTabs],
        isBuiltIn: true,
        templateSlug: template.slug,
        copiedAt: now,
        updatedBy: by,
      })));
    }
    return out;
  }

  private async seedSuperAdmin(
    m: EntityManager, tenantId: string, email: string, fullName: string, phone: string | null, by: string, now: Date,
  ): Promise<AppUser> {
    const repo = m.getRepository(AppUser);
    return repo.save(repo.create({
      tenantId, email, fullName: fullName.trim(), phone: phone?.trim() || null,
      roleSlug: 'ceo-manager', status: 'invited', passwordHash: null,
      externalUserId: null, externalSourceSystem: null,
      failedAttempts: 0, lockedUntil: null,
      invitedBy: by, invitedAt: now, activatedAt: null,
      suspendedAt: null, suspendedReason: null,
    }));
  }

  private async inviteSuperAdmin(
    m: EntityManager, tenant: Tenant, admin: AppUser, by: string, now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = this.passwords.newToken();
    const expiresAt = new Date(now.getTime() + 14 * 86_400_000);
    const repo = m.getRepository(UserInvitation);
    await repo.save(repo.create({
      tenantId: tenant.tenantId, userId: admin.id,
      tokenHash: this.passwords.fingerprint(token),
      purpose: 'invite', expiresAt, consumedAt: null, createdBy: by,
    }));
    return { token, expiresAt };
  }

  private async announce(m: EntityManager, tenant: Tenant, admin: AppUser, now: Date): Promise<void> {
    const repo = m.getRepository(DomainEvent);
    await repo.save(repo.create({
      eventType: 'tenant.provisioned.v1',
      tenantId: tenant.tenantId,
      subject: tenant.tenantId,
      payload: {
        name: tenant.name, plan: tenant.plan, region: tenant.region,
        superAdminEmail: admin.email,
      },
      occurredAt: now,
      deliveryState: 'pending',
      deliveredAt: null, attempts: 0, lastError: null,
    }));
  }

  private async setStatus(
    scope: RequestScope, tenantId: string, status: 'active' | 'suspended',
    reason: string | null, now: Date,
  ): Promise<Tenant & { superAdmin: SuperAdminContact | null }> {
    return runTenantSpanning(this.ds, `tenant ${status}: ${tenantId}`, async (m) => {
      const repo = m.getRepository(Tenant);
      const tenant = await repo.findOne({ where: { tenantId } });
      if (!tenant) throw new NotFoundException(`No account "${tenantId}".`);

      tenant.status = status;
      tenant.suspendedAt = status === 'suspended' ? now : null;
      tenant.suspendedReason = reason;
      const saved = await repo.save(tenant);
      const superAdmin = (await this.superAdminsFor(m, [tenantId])).get(tenantId) ?? null;
      return { ...saved, superAdmin };
    });
  }

  private requirePlatform(scope: RequestScope): void {
    if (!scope.isPlatformRole) {
      throw new BadRequestException('Only Things Alive can provision or suspend an account.');
    }
  }
}
