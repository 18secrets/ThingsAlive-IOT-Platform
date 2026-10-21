import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A platform staff sign-in and its refresh token — PlatformUser's counterpart to
 * UserSession, kept as a separate table rather than a shared one because a platform
 * user has no tenant_id and this table must not gain one: adding it back would put a
 * platform-staff row inside the exact isolation boundary this credential exists
 * outside of.
 */
@Entity('platform_session')
@Index('uq_platform_session_token', ['tokenHash'], { unique: true })
@Index('ix_platform_session_user', ['platformUserId', 'revokedAt'])
@Index('ix_platform_session_family', ['family'])
export class PlatformSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'platform_user_id', type: 'uuid' })
  platformUserId: string;

  /** SHA-256 of the refresh token. */
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  /** Every token descending from one sign-in shares this. Revoked as a unit. */
  @Column({ type: 'uuid' })
  family: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
