import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Common onboarding fields for a named/categorised kind of equipment (task: help a
 * client's Add Equipment form pre-fill from a matching template).
 *
 * Deliberately separate from `EquipmentClassProfile` — that table is the prediction
 * catalog (expected signals, failure modes, entitlement-gated, versioned) and this
 * one is onboarding convenience: no lifecycle, no entitlement, no tenant. It exists to
 * be copied into a client's own template and equipment record and then edited freely.
 *
 * Since D57 it is also the model a machine's rated figures come from: its ratings
 * (`equipment_template_rating`) copy with it, and a machine names the account's copy.
 */
@Entity('equipment_template')
export class EquipmentTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The library class this is a model of (D57); null for an onboarding-only template. */
  @Column({ name: 'equipment_class_slug', type: 'text', nullable: true })
  equipmentClassSlug: string | null;

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
