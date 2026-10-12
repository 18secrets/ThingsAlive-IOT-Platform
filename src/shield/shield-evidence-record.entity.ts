import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const SHIELD_CATEGORIES = ['compliance', 'safety', 'security'] as const;
export type ShieldCategory = (typeof SHIELD_CATEGORIES)[number];

export const SHIELD_RESULTS = ['passed', 'failed', 'attention'] as const;
export type ShieldResult = (typeof SHIELD_RESULTS)[number];

/**
 * One inspection or check on one machine (task QSHIELD1).
 *
 * Append-only: the migration refuses UPDATE and DELETE for every role. A correction is
 * a new row whose `supersedesId` names the one it corrects, and the corrected row stays
 * — evidence that can be quietly rewritten is not evidence.
 *
 * There is no status column. Whether a record is current, due soon or overdue depends
 * on today's date, and a stored status would be wrong the morning after it was written.
 */
@Entity('shield_evidence_record')
@Index('ix_shield_evidence_machine', ['tenantId', 'sourceSystem', 'externalId', 'performedAt'])
export class ShieldEvidenceRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ type: 'text' })
  category: ShieldCategory;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  result: ShieldResult;

  /** When the check happened — not when somebody typed it in. */
  @Column({ name: 'performed_at', type: 'timestamptz' })
  performedAt: Date;

  /** When the next one is due; null for a one-off. */
  @Column({ name: 'due_at', type: 'timestamptz', nullable: true })
  dueAt: Date | null;

  @Column({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId: string | null;

  /** For an owner with no account here — a contractor, an outside inspector. */
  @Column({ name: 'owner_name', type: 'text', nullable: true })
  ownerName: string | null;

  /** Certificate, checklist or permit number, as the outside world knows it. */
  @Column({ type: 'text', nullable: true })
  reference: string | null;

  @Column({ type: 'text', nullable: true })
  findings: string | null;

  /** From the token, never from the body. */
  @Column({ name: 'recorded_by', type: 'text' })
  recordedBy: string;

  @Column({ name: 'supersedes_id', type: 'uuid', nullable: true })
  supersedesId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
