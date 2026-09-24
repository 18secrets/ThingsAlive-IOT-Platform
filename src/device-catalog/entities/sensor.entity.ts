import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** One telemetry channel this sensor exposes, and the range it is expected to sit in. */
export interface SensorParameterSpec {
  parameter: string;
  unit: string;
  min: number;
  max: number;
  normalRange: string;
  notes?: string;
}

/**
 * A reference sensor Master Admin can wire into a Tool Mapping (task: master-data
 * pipeline for device onboarding).
 *
 * Platform-owned, flat master data — no tenant column, no row-level security, no
 * draft/publish lifecycle. Unlike `EquipmentClassProfile` this is never versioned:
 * the user asked for these as a plain reference table, not a product a tenant is
 * entitled to.
 *
 * No delete: a Tool Mapping stores a sensor's id, and removing the row out from
 * under a mapping would leave it pointing at nothing. Editing in place is enough —
 * this is reference data corrected over time, not content that ships to a customer.
 */
@Entity('sensor')
export class Sensor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sensor_name', type: 'text' })
  sensorName: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  @Index('ix_sensor_category')
  categoryId: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  protocol: string | null;

  @Column({ name: 'parameter_specs', type: 'jsonb', default: () => `'[]'::jsonb` })
  parameterSpecs: SensorParameterSpec[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
