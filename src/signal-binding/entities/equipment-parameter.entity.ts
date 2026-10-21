import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type EquipmentParameterStatus = 'proposed' | 'approved' | 'superseded' | 'rejected';
export type EquipmentParameterSource = 'equipment-template' | 'class-default' | 'manual' | 'model';

/**
 * A formula's non-telemetry input (`1757960000000-SignalBindings.ts`, task Q08S) —
 * a scalar such as tank capacity or service interval. An `equipment_template` value
 * lands here `proposed`; it is `parameters_required`, not a default, until somebody
 * with the right capability approves it — a template revision must never silently
 * rewrite a machine's approved value. At most one `approved` row per parameter per
 * equipment (`uq_equipment_parameter_approved`), so a formula's answer never depends
 * on which row it happened to read.
 */
@Entity('equipment_parameter')
export class EquipmentParameter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'parameter_key', type: 'text' })
  parameterKey: string;

  @Column({ type: 'double precision', nullable: true })
  value: number | null;

  @Column({ type: 'text' })
  unit: string;

  @Column({ type: 'text' })
  source: EquipmentParameterSource;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef: string | null;

  @Column({ type: 'text', default: 'proposed' })
  status: EquipmentParameterStatus;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'int', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
