import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Common onboarding fields for a named/categorised kind of equipment (task: help a
 * client's Add Equipment form pre-fill from a matching template).
 *
 * Deliberately separate from `EquipmentClassProfile` — that table is the prediction
 * catalog (expected signals, failure modes, entitlement-gated, versioned) and this
 * one is onboarding convenience only: no lifecycle, no entitlement, no tenant. It
 * exists to be copied into a client's own Equipment record and then edited freely;
 * nothing here is ever referenced back to by an Equipment row.
 */
@Entity('equipment_template')
export class EquipmentTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  /** Free-text grouping a client's onboarding form matches against, same as the old mock Category. */
  @Column({ type: 'text', nullable: true })
  @Index('ix_equipment_template_category')
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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
