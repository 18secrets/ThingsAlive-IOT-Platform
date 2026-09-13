import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What the token lets somebody do once they hold it. */
export type InvitationPurpose = 'invite' | 'reset';

/**
 * A single-use, time-boxed token for setting a password (task P1-88).
 *
 * Only the hash is stored. A token is high-entropy random rather than a chosen
 * secret, so a fast hash is the right one — bcrypt on 256 bits of randomness buys
 * nothing and costs a hundred milliseconds. What matters is that a database dump
 * hands nobody a working invitation.
 *
 * Invitations and resets share this table because they are the same mechanism with
 * different words on the email. Splitting them would mean two expiry rules, two
 * consumption checks and two places to forget one.
 */
@Entity('user_invitation')
@Index('uq_user_invitation_token', ['tokenHash'], { unique: true })
@Index('ix_user_invitation_user', ['tenantId', 'userId', 'consumedAt'])
export class UserInvitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** SHA-256 of the token. The token itself is returned once and never stored. */
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @Column({ type: 'text' })
  purpose: InvitationPurpose;

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
