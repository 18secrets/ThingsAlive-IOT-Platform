import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** The kinds of fault code an account can be given, each with its own table behind it. */
export const FAULT_CODE_TYPES = ['vehicle-j1939', 'vehicle-obd2', 'motor-pump'] as const;
export type FaultCodeType = (typeof FAULT_CODE_TYPES)[number];

/**
 * Which kinds of fault code an account is given (FaultCodeLibrary1765300000000): a
 * construction account the vehicle kinds, a motor account the pump kind.
 *
 * Platform-owned, like class entitlements: Master Admin writes it, and the account reads
 * its own rows. Row security's WITH CHECK admits only the tenant-spanning session, so no
 * account can write itself a grant whatever route it finds.
 *
 * Revoked rather than deleted, and one row per account and kind: a grant that existed
 * and was withdrawn is a different fact from one that never existed.
 */
@Entity('fault_code_type_grant')
@Index('uq_fault_code_type_grant', ['tenantId', 'codeType'], { unique: true })
export class FaultCodeTypeGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'code_type', type: 'text' })
  codeType: FaultCodeType;

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
