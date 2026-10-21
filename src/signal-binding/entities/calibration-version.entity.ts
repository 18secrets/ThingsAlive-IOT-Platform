import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CalibrationMethod = 'identity' | 'two_point' | 'multipoint';

/** One raw/reference pair a calibration was fitted from. */
export interface CalibrationPoint {
  raw: number;
  reference: number;
}

/**
 * How a raw reading becomes a canonical-unit value (`1757960000000-SignalBindings.ts`,
 * task Q08S). `identity` (raw equals canonical, unchanged) is permitted only with an
 * explicit approved basis recorded — `ck_calibration_identity_basis` enforces that a
 * non-null, non-blank `basis` accompanies it; never the default that happens when
 * nobody filled the form in.
 */
@Entity('calibration_version')
@Index('ix_calibration_version_tenant', ['tenantId'])
export class CalibrationVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  method: CalibrationMethod;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  points: CalibrationPoint[];

  @Column({ name: 'raw_unit', type: 'text', nullable: true })
  rawUnit: string | null;

  @Column({ name: 'reference_unit', type: 'text', nullable: true })
  referenceUnit: string | null;

  /** Why `identity` is acceptable here — an approved factory or ECU basis. */
  @Column({ type: 'text', nullable: true })
  basis: string | null;

  @Column({ name: 'performed_at', type: 'timestamptz', nullable: true })
  performedAt: Date | null;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'certificate_ref', type: 'text', nullable: true })
  certificateRef: string | null;

  @Column({ type: 'double precision', nullable: true })
  uncertainty: number | null;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
