import { Column, Entity, Index } from 'typeorm';
import { ProjectionBase } from './projection-base';

/**
 * Which physical sensor on which device serves which canonical signal.
 *
 * This is the projection that goes stale most dangerously: a remapped sensor
 * upstream means every score computed here afterwards is attributing readings to
 * the wrong signal.
 */
@Entity('sensor_map_projection')
@Index('uq_sensor_map_projection_external', ['sourceSystem', 'externalId'], { unique: true })
@Index('ix_sensor_map_projection_tenant', ['tenantId'])
export class SensorMapProjection extends ProjectionBase {
  @Column({ type: 'text' })
  @Index('ix_sensor_map_projection_imei')
  imei: string;

  /** The canonical signal name in 2.0's vocabulary, e.g. fuel_consumption_lph. */
  @Column({ type: 'text' })
  signal: string;

  @Column({ name: 'sensor_name', type: 'text', nullable: true })
  sensorName: string | null;

  @Column({ type: 'text', nullable: true })
  unit: string | null;
}
