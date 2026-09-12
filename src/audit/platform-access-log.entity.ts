import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Who from Things Alive looked at which customer's data, and why (task P1-59).
 *
 * Write auditing is common and insufficient. The access that matters here is a read:
 * a support engineer opening a tenant's predictions changes nothing and, without
 * this table, leaves no trace. The customer asking "who saw our data" deserves an
 * answer that is not "we assume nobody".
 *
 * Deliberately not tenant-owned and deliberately outside row-level security — the
 * subject of the record must not be able to edit it, and the tenant read is what is
 * being recorded, not what is being protected.
 */
@Entity('platform_access_log')
@Index('ix_platform_access_tenant_at', ['tenantId', 'at'])
@Index('ix_platform_access_actor_at', ['actorUserId', 'at'])
export class PlatformAccessLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;

  @Column({ name: 'actor_user_id', type: 'text' })
  actorUserId: string;

  /** The roles as they stood at the time. Roles get revoked; the record should not change. */
  @Column({ name: 'actor_roles', type: 'text', array: true, default: () => `'{}'::text[]` })
  actorRoles: string[];

  /** The tenant whose data was read — the actor's own tenant claim, or the one targeted. */
  @Column({ name: 'tenant_id', type: 'text', nullable: true })
  tenantId: string | null;

  /** Tenants named explicitly on a cross-tenant read. Null means "unbounded". */
  @Column({ name: 'tenant_ids', type: 'text', array: true, nullable: true })
  tenantIds: string[] | null;

  /** Table or route touched. */
  @Column({ type: 'text' })
  resource: string;

  @Column({ type: 'text' })
  action: 'read' | 'cross-tenant-read';

  /** Free text from the caller. Required on the cross-tenant path. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'text', nullable: true })
  method: string | null;

  @Column({ type: 'text', nullable: true })
  path: string | null;
}
