import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** How soon someone acts — a different axis from how bad the failure is, so not the
 * severity vocabulary. These four are how a maintenance team on construction plant
 * actually schedules work. */
export const RECOMMENDATION_URGENCY_VALUES = ['immediate', 'next_shift', 'next_service', 'monitor'] as const;
export type RecommendationUrgency = (typeof RECOMMENDATION_URGENCY_VALUES)[number];

/** `numeric` comes back from the driver as a string; the column means hours. */
export const numericHours = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/**
 * What a person does about a failure mode (`1758100000000-LibraryContent.ts`, task
 * QREC0a).
 *
 * Points at a failure mode on the same class version by (class_slug, class_version,
 * failure_mode_code), and the foreign key is what makes that a guarantee — a
 * recommendation for a failure mode the class does not have is refused by the
 * database, not merely flagged.
 *
 * Nothing surfaces these to a tenant yet; that is QPAGE1.
 */
@Entity('equipment_class_recommendation')
export class EquipmentClassRecommendation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ name: 'failure_mode_code', type: 'text' })
  failureModeCode: string;

  @Column({ type: 'text' })
  action: string;

  @Column({ type: 'text' })
  urgency: RecommendationUrgency;

  @Column({ name: 'estimated_hours', type: 'numeric', nullable: true, transformer: numericHours })
  estimatedHours: number | null;

  @Column({ name: 'required_parts', type: 'jsonb', nullable: true })
  requiredParts: unknown[] | null;

  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
