import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Severity } from '../../common/severity';

/**
 * One way a class of machine fails (`1758100000000-LibraryContent.ts`, task QREC0a).
 *
 * Was an entry in `equipment_class_profile.failure_modes`. It became a row because a
 * recommendation has to point at one, and jsonb has no identity to point at. The
 * jsonb is still written alongside, deprecated, until QREC0c drops it — nothing reads
 * it any more.
 *
 * Platform-owned, versioned with the class via (class_slug, class_version), same as
 * the sensor requirement and formula tables beside it.
 */
@Entity('equipment_class_failure_mode')
export class EquipmentClassFailureMode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  /** Stable, unique within (class, version) — what a recommendation names. Meant to
   * be snake_case; not enforced yet, see 1758100000000-LibraryContent.ts. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  name: string;

  /** What the operator would notice. Kept under the word the authors already use. */
  @Column({ type: 'text', default: '' })
  symptom: string;

  /** NULL means nobody declared one (D32) — every row converted from jsonb is NULL. */
  @Column({ type: 'text', nullable: true })
  severity: Severity | null;

  /** Declared signals that move when this happens. One the class does not declare is
   * refused at publish, not stored as a draft. */
  @Column({ type: 'text', array: true, default: '{}' })
  signals: string[];

  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
