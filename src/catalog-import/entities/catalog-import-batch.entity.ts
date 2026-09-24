import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CatalogImportBatchStatus = 'parsed' | 'validated' | 'rejected' | 'applied';

/**
 * One uploaded workbook (task QIMP1).
 *
 * Platform-owned: no tenant_id, no row-level security, exactly like
 * `equipment_class_profile` — the library this workbook feeds is Things Alive's, not a
 * tenant's.
 */
@Entity('catalog_import_batch')
@Index('uq_catalog_import_batch_checksum', ['checksumSha256'], { unique: true })
export class CatalogImportBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  filename: string;

  /** The same workbook cannot be staged twice. */
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
}
