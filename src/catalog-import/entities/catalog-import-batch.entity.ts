import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type CatalogImportBatchStatus = 'parsed' | 'validated' | 'rejected' | 'applied';

/**
 * One uploaded workbook (task QIMP1).
 *
 * Platform-owned: no tenant_id, no row-level security, exactly like
 * `equipment_class_profile` — the library this workbook feeds is Things Alive's, not a
 * tenant's.
 */
@Entity('catalog_import_batch')
export class CatalogImportBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  filename: string;

  /**
   * Provenance, not a uniqueness key (task QIMP4) — the loop is upload, read the
   * diff, fix something outside the workbook, upload the same bytes again, and that
   * has to work. `CatalogImportDiffService` uses this to note a repeat rather than
   * refuse one.
   */
  @Column({ name: 'checksum_sha256', type: 'text' })
  checksumSha256: string;

  @Column({ name: 'template_version', type: 'text' })
  templateVersion: string;

  @Column({ name: 'uploaded_by', type: 'text' })
  uploadedBy: string;

  @Column({ type: 'text', default: 'parsed' })
  status: CatalogImportBatchStatus;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  summary: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt: Date | null;

  @Column({ name: 'applied_by', type: 'text', nullable: true })
  appliedBy: string | null;

  /** Who approved or dismissed which proposed sensor or category, against this
   * batch (task QIMP5) — the audit trail for a decision that creates reference
   * data nobody re-uploads a workbook to undo. */
  @Column({ name: 'sensor_decisions', type: 'jsonb', default: () => `'[]'::jsonb` })
  sensorDecisions: SensorDecision[];
}

export interface SensorDecision {
  kind: 'sensor' | 'category';
  slug: string;
  decision: 'approved' | 'dismissed';
  by: string;
  at: string;
}
