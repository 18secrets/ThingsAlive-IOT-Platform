import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type UserStatus = 'invited' | 'active' | 'suspended';

/**
 * A person who signs in to 2.0 (tasks P1-21, P1-83).
 *
 * 2.0 creates users now, which makes it an identity provider rather than a consumer
 * of one. This slice holds the record; credentials and the login that uses them are
 * the next one, which is why an invited user has no password hash and cannot sign in.
 *
 * `externalUserId` is nullable and empty today. It is here from the first migration
 * because the existing platform's users are to be merged in later, and a merge with
 * nowhere to record the correspondence becomes a duplicate instead — two rows for one
 * person, diverging quietly, which is the exact outcome the merge is meant to avoid.
 *
 * Email is unique across the platform rather than within an account. A person gets
 * one login; what varies is what they are assigned to, and assignment already spans
 * as many sites and machines as needed.
 */
@Entity('app_user')
@Index('uq_app_user_email', ['email'], { unique: true })
@Index('ix_app_user_tenant', ['tenantId', 'status'])
export class AppUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** Stored lower-cased and trimmed. Comparing raw input would let case create a twin. */
  @Column({ type: 'text' })
  email: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName: string;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  /** References tenant_role.slug in the same account. */
  @Column({ name: 'role_slug', type: 'text' })
  roleSlug: string;

  @Column({ type: 'text', default: 'invited' })
  status: UserStatus;

  /**
   * Null until the next slice sets a password. A null hash is not "any password
   * works" anywhere in this codebase — the login path refuses it outright.
   */
  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  /** Where this person came from, once the existing platform's users are merged. */
  @Column({ name: 'external_user_id', type: 'text', nullable: true })
  externalUserId: string | null;

  @Column({ name: 'external_source_system', type: 'text', nullable: true })
  externalSourceSystem: string | null;

  /**
   * Consecutive failures since the last success, and the lockout they earn.
   *
   * Counters on the row rather than a rate limiter in front of the route, because the
   * thing being protected is one account rather than one caller: an attacker spreading
   * attempts across addresses defeats a per-IP limit and not this.
   */
  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'invited_by', type: 'text', nullable: true })
  invitedBy: string | null;

  @Column({ name: 'invited_at', type: 'timestamptz', nullable: true })
  invitedAt: Date | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  @Column({ name: 'suspended_reason', type: 'text', nullable: true })
  suspendedReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
