import { ForbiddenException, Logger } from '@nestjs/common';
import {
  DataSource, DeepPartial, EntityManager, EntityTarget, FindOptionsOrder,
  FindOptionsWhere, In, ObjectLiteral,
} from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { AuditService } from '../audit/audit.service';
import { ScopedEntityMeta, TenantOwnedEntity } from './tenant-owned';
import { runTenantSpanning, withTenantSession } from './tenant-session';

/**
 * A `where` a caller is allowed to write: everything except the tenant.
 *
 * Removing `tenantId` from the type is the whole point. The existing platform's
 * handlers take a client id from the request and filter on it, which means every
 * endpoint is one missing check away from serving another customer's rows. Here the
 * tenant is not a parameter, so it cannot be the wrong one.
 */
export type ScopedWhere<T> = Omit<FindOptionsWhere<T>, 'tenantId'>;

export interface ScopedFindOptions<T> {
  where?: ScopedWhere<T> | ScopedWhere<T>[];
  order?: FindOptionsOrder<T>;
  take?: number;
  skip?: number;
}

/** A scope that matches nothing — an empty allow-list, not an absent one. */
const MATCHES_NOTHING = Symbol('matches-nothing');

/**
 * The only supported way to read or write a tenant-owned table (task P1-52).
 *
 * Every method takes a `RequestScope` as its first argument, so an unscoped query is
 * a compile error rather than something a reviewer has to notice. The tenant filter
 * is applied here, and Postgres applies it again through row-level security — two
 * layers, because the first one is code and code gets edited.
 *
 * Cross-tenant reads are possible, but only through `acrossTenants()`, only for a
 * platform role, and only with a reason that is written to the audit log first.
 */
export class ScopedRepository<T extends ObjectLiteral & TenantOwnedEntity> {
  private readonly logger = new Logger(ScopedRepository.name);

  constructor(
    private readonly ds: DataSource,
    private readonly target: EntityTarget<T>,
    private readonly meta: ScopedEntityMeta<T> = {},
    private readonly audit?: AuditService,
  ) {}

  async find(scope: RequestScope, options: ScopedFindOptions<T> = {}): Promise<T[]> {
    const where = this.buildWhere(scope, options.where);
    if (where === MATCHES_NOTHING) return [];
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(this.target).find({ ...options, where } as any),
    );
  }

  async findOne(scope: RequestScope, options: ScopedFindOptions<T> = {}): Promise<T | null> {
    const where = this.buildWhere(scope, options.where);
    if (where === MATCHES_NOTHING) return null;
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(this.target).findOne({ ...options, where } as any),
    );
  }

  async count(scope: RequestScope, options: ScopedFindOptions<T> = {}): Promise<number> {
    const where = this.buildWhere(scope, options.where);
    if (where === MATCHES_NOTHING) return 0;
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(this.target).count({ where } as any),
    );
  }

  /**
   * Writes stamp the tenant from the scope and overwrite anything the caller supplied.
   * A body that carries its own tenantId is a request to write into another customer's
   * data, whether or not whoever sent it meant it that way.
   */
  async save(scope: RequestScope, entity: DeepPartial<Omit<T, 'tenantId'>>): Promise<T> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(this.target);
      const row = repo.create({ ...(entity as any), tenantId: scope.tenantId } as DeepPartial<T>);
      return repo.save(row as DeepPartial<T>) as Promise<T>;
    });
  }

  /** Updates are confined to the scope's own rows: the criteria cannot widen it. */
  async update(
    scope: RequestScope,
    where: ScopedWhere<T>,
    patch: DeepPartial<Omit<T, 'tenantId'>>,
  ): Promise<number> {
    const scoped = this.buildWhere(scope, where);
    if (scoped === MATCHES_NOTHING) return 0;
    return withTenantSession(this.ds, scope, async (m) => {
      const res = await m.getRepository(this.target).update(scoped as any, patch as any);
      return res.affected ?? 0;
    });
  }

  /**
   * Several statements against one tenant session, for work that must be atomic.
   * The manager is inside the transaction that carries `ta.tenant_id`, so row-level
   * security still applies to every statement issued through it.
   */
  async transaction<R>(scope: RequestScope, fn: (m: EntityManager) => Promise<R>): Promise<R> {
    return withTenantSession(this.ds, scope, fn);
  }

  /**
   * A read that deliberately crosses tenants (task P1-59).
   *
   * Support work sometimes needs this. What it must never be is indistinguishable
   * from an ordinary read, so: a platform role is required, a reason is required, and
   * the access is recorded before the rows are returned. If the audit write fails the
   * read fails — an unrecorded support read is the exact thing this prevents, and
   * failing open would quietly turn the control off on the day the log breaks.
   */
  async acrossTenants(
    scope: RequestScope,
    reason: string,
    options: ScopedFindOptions<T> & { tenantIds?: string[] } = {},
  ): Promise<T[]> {
    if (!scope.isPlatformRole) {
      throw new ForbiddenException('Cross-tenant reads require a platform role.');
    }
    if (!reason || !reason.trim()) {
      throw new ForbiddenException('A cross-tenant read must state a reason; it is recorded.');
    }
    if (!this.audit) {
      throw new ForbiddenException('Cross-tenant reads are unavailable without the audit log.');
    }

    const entityName = this.ds.getMetadata(this.target).tableName;
    await this.audit.recordCrossTenantRead(scope, {
      resource: entityName,
      reason: reason.trim(),
      tenantIds: options.tenantIds ?? null,
    });

    const where = options.tenantIds?.length
      ? this.merge(options.where, { tenantId: In(options.tenantIds) } as any)
      : (options.where as any);

    this.logger.warn(
      `Cross-tenant read of ${entityName} by ${scope.userId} (${scope.roles.join(',')}): ${reason}`,
    );
    // Tenant-spanning by definition, so it needs the same exemption the sync uses —
    // with the difference that this one has already been written to the access log.
    return runTenantSpanning(this.ds, `support read: ${reason}`, (m) =>
      m.getRepository(this.target).find({ ...options, where } as any),
    );
  }

  /**
   * Builds the effective filter: the caller's conditions, plus the tenant, plus
   * whatever asset narrowing the scope carries and this table can honour.
   *
   * `undefined` on a scope list means unrestricted within the tenant. An empty array
   * means the opposite — entitled to nothing — and the difference matters: treating
   * `[]` as "no filter" is how a user with no assigned equipment sees all of it.
   */
  private buildWhere(
    scope: RequestScope,
    where?: ScopedWhere<T> | ScopedWhere<T>[],
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] | typeof MATCHES_NOTHING {
    const narrowing: Record<string, unknown> = { tenantId: scope.tenantId };

    const narrow = (column: string | undefined, ids: readonly string[] | undefined) => {
      if (!column || ids === undefined) return false;
      if (ids.length === 0) return true; // entitled to nothing
      narrowing[column] = In([...ids]);
      return false;
    };

    if (
      narrow(this.meta.equipmentColumn, scope.equipmentIds) ||
      narrow(this.meta.deviceColumn, scope.deviceIds) ||
      narrow(this.meta.plantColumn, scope.plantIds)
    ) {
      return MATCHES_NOTHING;
    }

    if (Array.isArray(where)) {
      return where.map((w) => this.merge(w, narrowing)) as FindOptionsWhere<T>[];
    }
    return this.merge(where, narrowing) as FindOptionsWhere<T>;
  }

  /** The narrowing is applied last so a caller's condition can never displace it. */
  private merge(where: unknown, narrowing: Record<string, unknown>): Record<string, unknown> {
    return { ...((where as Record<string, unknown>) ?? {}), ...narrowing };
  }
}
