import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A client's own equipment template (task QCLIENT-TEMPLATE): Master Admin's onboarding
 * fields, owned by one account and invisible to every other.
 *
 * Onboarding fields only. Alert rules, KPI formulas and predictive rules belong on the
 * client's copy of an equipment class (`my-catalog`), which is what the alert engine and
 * the KPI evaluator read; a second place to define them would be one nothing runs.
 */
@Entity('client_equipment_template')
export class ClientEquipmentTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  category: string | null;

  @Column({ type: 'text', nullable: true })
  manufacturer: string | null;

  @Column({ name: 'engine_type', type: 'text', nullable: true })
  engineType: string | null;

  @Column({ name: 'fuel_tank_capacity_liters', type: 'double precision', nullable: true })
  fuelTankCapacityLiters: number | null;

  @Column({ name: 'service_interval_hours', type: 'int', nullable: true })
  serviceIntervalHours: number | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The Master Admin template this started from — provenance only, never followed. */
  @Column({ name: 'copied_from_id', type: 'uuid', nullable: true })
  copiedFromId: string | null;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
