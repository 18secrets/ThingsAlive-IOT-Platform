import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SecurityEventType =
  | 'login.succeeded'
  | 'login.failed'
  | 'login.locked'
  | 'password.set'
  | 'password.reset-requested'
  | 'session.refreshed'
  | 'session.reuse-detected'
  | 'session.signed-out'
  | 'session.revoked';

/**
 * What happened to an account, kept whether or not it succeeded (task P1-88).
 *
 * The failures are the point. A successful login tells nobody anything; two hundred
 * failures against one address overnight tells you a great deal, and it is only
 * visible if the failures were recorded at the time.
 *
 * No tenant filter is possible on a failed login for an address that does not exist,
 * so those rows carry a null tenant and are invisible inside every account — the same
 * property the device pool relies on, for the same reason.
 */
@Entity('user_security_event')
@Index('ix_user_security_event_user', ['userId', 'at'])
@Index('ix_user_security_event_type', ['type', 'at'])
export class UserSecurityEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text', nullable: true })
  tenantId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Recorded even when no account matched, which is when it matters most. */
  @Column({ name: 'email_attempted', type: 'text', nullable: true })
  emailAttempted: string | null;

  @Column({ type: 'text' })
  type: SecurityEventType;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
