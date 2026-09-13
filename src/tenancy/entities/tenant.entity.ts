import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type TenantStatus = 'active' | 'suspended';

/**
 * The account itself (task P1-89).
 *
 * Until now a tenant has been a string that appears in a column — every table is
 * narrowed by it and nothing describes it. That works right up to the first question
 * anybody asks about a customer: what are they called, what did they buy, are they
 * still paying. It also leaves no way to turn an account off, which is the one
 * commercial lever Things Alive has and the one thing the platform could not do.
 *
 * The primary key is named `tenant_id` rather than `id`, which reads oddly on a table
 * called `tenant` and is deliberate: the derived row-level-security check finds every
 * table carrying a `tenant_id` column and asserts it has a policy. Naming the column
 * `id` would have left this table protected by hand and unwatched by the guard, which
 * is precisely the arrangement that guard exists to prevent.
 */
@Entity('tenant')
@Index('ix_tenant_status', ['status'])
export class Tenant {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'active' })
  status: TenantStatus;

  /** What they bought. Nullable because a trial account has not bought anything yet. */
  @Column({ type: 'text', nullable: true })
  plan: string | null;

  @Column({ type: 'text', nullable: true })
  region: string | null;

  /**
   * Suspending an account is not the same as suspending everybody in it.
   *
   * This is the commercial lever: non-payment, a contract ending, a security
   * incident. It stops every sign-in at once without touching a single user record,
   * so reinstating it restores exactly what was there rather than requiring somebody
   * to remember who was active.
   */
  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ name: 'suspended_reason', type: 'text', nullable: true })
  suspendedReason: string | null;

  @Column({ name: 'provisioned_by', type: 'text', nullable: true })
  provisionedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
