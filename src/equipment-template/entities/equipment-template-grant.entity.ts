import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Which library models an account is given (ModelGrants1766000000000, TC_234). An account
 * lists and copies only these; Master Admin sees the whole library.
 *
 * Platform-owned, like class entitlements and fault code grants: Master Admin writes it,
 * and the account reads its own rows. Row security's WITH CHECK admits only the
 * tenant-spanning session, so no account can write itself a grant whatever route it finds.
 *
 * Revoked rather than deleted, and one row per account and model: a grant that existed
 * and was withdrawn is a different fact from one that never existed.
 */
@Entity('equipment_template_grant')
@Index('uq_equipment_template_grant', ['tenantId', 'templateId'], { unique: true })
export class EquipmentTemplateGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ name: 'granted_by', type: 'text' })
  grantedBy: string;

  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'text', nullable: true })
  revokedBy: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
