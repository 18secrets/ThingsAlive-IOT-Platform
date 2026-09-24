import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SensorInstanceStatus = 'active' | 'retired';

/**
 * A `device-catalog` sensor DEFINITION, fitted at a position on one equipment
 * (`1757960000000-SignalBindings.ts`, task Q08S). References `sensor.id` rather
 * than duplicating it — `sensor` stays device-catalog's, this is just where.
 */
@Entity('sensor_instance')
@Index('ix_sensor_instance_equipment', ['tenantId', 'sourceSystem', 'externalId'])
export class SensorInstance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'sensor_id', type: 'uuid' })
  sensorId: string;

  /** '' is the machine itself, same convention as `signal_binding_version.component_id`. */
  @Column({ name: 'component_id', type: 'text', default: '' })
  componentId: string;

  @Column({ type: 'text', nullable: true })
  position: string | null;

  @Column({ type: 'text', nullable: true })
  serial: string | null;

  @Column({ name: 'installed_at', type: 'timestamptz', nullable: true })
  installedAt: Date | null;

  @Column({ name: 'calibration_requirement', type: 'text', nullable: true })
  calibrationRequirement: string | null;

  @Column({ type: 'text', default: 'active' })
  status: SensorInstanceStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
