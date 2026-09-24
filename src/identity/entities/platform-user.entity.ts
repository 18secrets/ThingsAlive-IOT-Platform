import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PlatformUserStatus = 'invited' | 'active' | 'suspended';

/**
 * A Things Alive staff credential (task QPA1; `invited` and the invitation columns
 * added by QPA2).
 *
 * Every platform-role token before this one was minted by a CLI script reading
 * `AUTH_JWT_SECRET` off the running service's own shell — no row, no password,
 * nothing to suspend. That was deliberate (see PLATFORM_ROLES): a stateless token
 * cannot leak from a customer's database because it was never in one. This table
 * exists because that trade was made the other way on purpose — Things Alive wanted
 * an ordinary, revocable staff login instead, the same shape as a tenant's own users.
 *
 * It carries no `tenant_id` and is not row-level-security protected: a platform user
 * is not tenant data, the same reason `tenant` itself carries no tenant column.
 */
@Entity('platform_user')
@Index('uq_platform_user_email', ['email'], { unique: true })
export class PlatformUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stored lower-cased and trimmed, same convention as app_user.email. */
  @Column({ type: 'text' })
  email: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName: string;

  /** One of PLATFORM_ROLES — checked at creation, not by a DB constraint alone. */
  @Column({ type: 'text' })
  role: string;

  @Column({ type: 'text', default: 'active' })
  status: PlatformUserStatus;

  /**
   * Null until somebody accepts their invitation. Not "any password works" anywhere
   * in this codebase — `PasswordService.verify` refuses a null hash outright, the
   * same convention as `AppUser.passwordHash`.
   */
  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /** Text, not a foreign key — same convention as `AppUser.invitedBy`. */
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
