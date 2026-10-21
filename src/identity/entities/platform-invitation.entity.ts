import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A single-use, time-boxed token for a staff member to set their first password
 * (task QPA2) — `UserInvitation`'s counterpart for `platform_user`.
 *
 * No `purpose` column: unlike a tenant user, a staff member already has
 * `change-password` for a known password and has no forgot-password flow yet, so
 * this table exists for exactly one reason rather than two sharing a shape.
 *
 * No `tenant_id` and no row-level-security policy, the same reason `platform_user`
 * and `platform_session` carry neither: a platform invitation is not tenant data.
 */
@Entity('platform_invitation')
@Index('uq_platform_invitation_token', ['tokenHash'], { unique: true })
@Index('ix_platform_invitation_user', ['platformUserId', 'consumedAt'])
export class PlatformInvitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'platform_user_id', type: 'uuid' })
  platformUserId: string;

  /** SHA-256 of the token. The token itself is returned once and never stored. */
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Set the moment it is used. A consumed token is dead even if it has not expired. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
