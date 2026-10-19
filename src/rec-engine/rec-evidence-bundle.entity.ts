import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type BundleStatus = 'ready' | 'not_configured' | 'blocked';
export type BundleReason = 'unclassified' | 'class_not_in_account' | 'no_library_content' | 'insufficient_coverage';
export type BundleOutcome = 'attributed' | 'unattributed' | 'inconclusive' | 'nothing_detected';

/** One evaluation of the five steps for one machine (task QREC1). See `1761000000000-RecEvidenceBundle.ts`. */
@Entity('rec_evidence_bundle')
export class RecEvidenceBundle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'incident_id', type: 'uuid', nullable: true })
  incidentId: string | null;

  @Column({ name: 'as_of', type: 'timestamptz' })
  asOf: Date;

  @Column({ name: 'engine_version', type: 'text' })
  engineVersion: string;

  @Column({ name: 'class_slug', type: 'text', nullable: true })
  classSlug: string | null;

  @Column({ name: 'class_template_version', type: 'int', nullable: true })
  classTemplateVersion: number | null;

  @Column({ name: 'inputs_hash', type: 'text' })
  inputsHash: string;

  @Column({ type: 'text' })
  status: BundleStatus;

  @Column({ type: 'text', nullable: true })
  reason: BundleReason | null;

  @Column({ type: 'text', nullable: true })
  outcome: BundleOutcome | null;

  @Column({ type: 'jsonb' })
  detect: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  attribute: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  precedent: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  gap: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  cost: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  candidates: unknown[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
