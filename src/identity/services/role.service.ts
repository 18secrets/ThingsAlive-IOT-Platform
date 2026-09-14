import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ALL_CAPABILITIES, Capability } from '../../auth/capabilities';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantId, withTenantSession } from '../../scope/tenant-session';
import { AppUser } from '../entities/app-user.entity';
import { ScopeShape, TenantRole } from '../entities/tenant-role.entity';
import { ROLE_TEMPLATES } from '../role-templates';

export interface RoleInput {
  slug: string;
  name: string;
  description?: string | null;
  capabilities: string[];
  scopeShape: ScopeShape;
}

const SCOPE_SHAPES: ScopeShape[] = ['tenant', 'plant', 'equipment'];

/**
 * The account's roles (tasks P1-21, P1-83).
 *
 * A client composes roles from a fixed vocabulary. Every capability named on a write
 * is checked against the union the application actually reads, and an unknown one is
 * refused rather than stored — a role granting "reports.export" when no code has ever
 * heard of it is a permission that looks given and does nothing, and the person who
 * granted it has no way to tell.
 */
@Injectable()
export class RoleService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Give a new account the three starting roles.
   *
   * Copies, not references. Re-running it never overwrites: a client who has renamed
   * "Operator" or narrowed what it can do has said something, and provisioning is not
   * entitled to undo it.
   */
  async provisionDefaults(tenantId: string, by: string, now = new Date()): Promise<TenantRole[]> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const repo = m.getRepository(TenantRole);
      const out: TenantRole[] = [];

      for (const template of ROLE_TEMPLATES) {
        const existing = await repo.findOne({ where: { tenantId, slug: template.slug } });
        if (existing) { out.push(existing); continue; }

        out.push(await repo.save(repo.create({
          tenantId,
          slug: template.slug,
          name: template.name,
          description: template.description,
          capabilities: [...template.capabilities],
          scopeShape: template.scopeShape,
          isBuiltIn: true,
          templateSlug: template.slug,
          copiedAt: now,
          updatedBy: by,
        })));
      }
      return out;
    });
  }

  async list(scope: RequestScope): Promise<TenantRole[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(TenantRole).find({
        where: { tenantId: scope.tenantId },
        order: { name: 'ASC' },
      }),
    );
  }

  async create(scope: RequestScope, input: RoleInput): Promise<TenantRole> {
    const capabilities = this.validate(input);
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(TenantRole);
      if (await repo.findOne({ where: { tenantId: scope.tenantId, slug: input.slug } })) {
        throw new ConflictException(`A role "${input.slug}" already exists in this account.`);
      }
      return repo.save(repo.create({
        tenantId: scope.tenantId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        capabilities,
        scopeShape: input.scopeShape,
        isBuiltIn: false,
        templateSlug: null,
        copiedAt: null,
        updatedBy: scope.userId,
      }));
    });
  }

  /**
   * Edit a role, including one that arrived as a template copy.
   *
   * The slug never changes. Users point at it, assignments are keyed on it, and a
   * rename that moved it would silently re-point every holder — so the display name
   * is editable and the identifier is not.
   */
  async update(scope: RequestScope, slug: string, input: Partial<RoleInput>): Promise<TenantRole> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(TenantRole);
      const role = await repo.findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!role) throw new NotFoundException(`No role "${slug}" in this account.`);

      // Each field checked only when it is being changed. Validating the whole shape
      // on a partial edit is how "rename this role" came to fail for not restating a
      // scope shape nobody was touching.
      if (input.capabilities) role.capabilities = this.validateCapabilities(input.capabilities);
      if (input.scopeShape) role.scopeShape = this.validateScopeShape(input.scopeShape);
      if (input.name !== undefined) role.name = input.name;
      if (input.description !== undefined) role.description = input.description ?? null;
      role.updatedBy = scope.userId;
      return repo.save(role);
    });
  }

  /**
   * Remove a role nobody holds.
   *
   * Two refusals rather than a cascade. A built-in cannot go, because the holders of
   * the other two need somewhere to be moved to. And a role in use cannot go, because
   * deleting it would leave people pointing at nothing — which reads on a screen as
   * "no permissions" and in a database as a broken key.
   */
  async remove(scope: RequestScope, slug: string): Promise<void> {
    await withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(TenantRole);
      const role = await repo.findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!role) throw new NotFoundException(`No role "${slug}" in this account.`);
      if (role.isBuiltIn) {
        throw new BadRequestException(
          `"${role.name}" is one of the roles every account has. It can be renamed and `
          + 'its permissions changed, but not removed.',
        );
      }

      const holders = await this.holderCount(m, scope.tenantId, slug);
      if (holders > 0) {
        throw new ConflictException(
          `${holders} ${holders === 1 ? 'person holds' : 'people hold'} "${role.name}". `
          + 'Move them to another role first.',
        );
      }
      await repo.remove(role);
    });
  }

  private async holderCount(m: EntityManager, tenantId: string, slug: string): Promise<number> {
    return m.getRepository(AppUser).count({ where: { tenantId, roleSlug: slug } });
  }

  private validate(input: RoleInput): Capability[] {
    if (!input.slug?.trim()) throw new BadRequestException('A role needs a slug.');
    this.validateScopeShape(input.scopeShape);
    return this.validateCapabilities(input.capabilities ?? []);
  }

  /** Capabilities are a closed vocabulary. Anything outside it is refused by name. */
  private validateCapabilities(capabilities: string[]): Capability[] {
    const known = new Set<string>(ALL_CAPABILITIES);
    const unknown = capabilities.filter((c) => !known.has(c));
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown ${unknown.length === 1 ? 'capability' : 'capabilities'}: ${unknown.join(', ')}. `
        + 'A role can only grant what the application checks for.',
      );
    }
    return [...new Set(capabilities as Capability[])];
  }

  private validateScopeShape(shape: ScopeShape): ScopeShape {
    if (!SCOPE_SHAPES.includes(shape)) {
      throw new BadRequestException(
        `Unknown scope shape "${shape}". One of: ${SCOPE_SHAPES.join(', ')}.`,
      );
    }
    return shape;
  }
}
