import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One sign-in, and the refresh token that keeps it alive (task P1-88).
 *
 * The access token is short-lived and stateless; this is what lets somebody stay
 * signed in without one that lasts a year — which is the thing wrong with the
 * existing platform's token and the reason this table exists at all.
 *
 * Refresh tokens rotate: every use issues a new one and retires the old. A retired
 * token being presented again is the signal that one was stolen, because the
 * legitimate holder would have the new one. `family` is what makes that actionable —
 * the whole chain descending from one sign-in is revoked together, so a thief who
 * refreshed once is thrown out along with their copy.
 */
@Entity('user_session')
@Index('uq_user_session_token', ['tokenHash'], { unique: true })
@Index('ix_user_session_user', ['tenantId', 'userId', 'revokedAt'])
@Index('ix_user_session_family', ['family'])
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

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

  /** Why it ended: rotated, signed out, suspended, or reuse detected. */
  @Column({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
