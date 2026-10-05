import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';

/**
 * A client's own copy of a class failure mode (task QREC0a — see ClientEquipmentClass
 * for the copy model this follows).
 *
 * Replaces `client_equipment_class.failure_modes` as the thing that is read; the
 * jsonb is still populated on copy, deprecated, until QREC0c drops it.
 */
@Entity('client_equipment_class_failure_mode')
@Index('uq_client_failure_mode', ['tenantId', 'clientEquipmentClassSlug', 'code'], { unique: true })
export class ClientEquipmentClassFailureMode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', default: '' })
  symptom: string;

  @Column({ type: 'text', nullable: true })
  severity: Severity | null;

  @Column({ type: 'text', array: true, default: '{}' })
  signals: string[];

  /** The class version this was copied from — same role it plays on ClientFormula. */
  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
