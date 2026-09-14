import { Column, Entity, Index } from 'typeorm';
import { ProjectionBase } from './projection-base';

@Entity('device_projection')
@Index('uq_device_projection_external', ['sourceSystem', 'externalId'], { unique: true })
@Index('ix_device_projection_tenant', ['tenantId'])
export class DeviceProjection extends ProjectionBase {
  /**
   * The business key that survives everything (task P1-40).
   *
   * Unique per source system rather than globally: two upstream systems could
   * legitimately report the same physical device, and that is a reconciliation
   * question rather than a constraint violation.
   */
  @Column({ type: 'text' })
  @Index('ix_device_projection_imei')
  imei: string;

  @Column({ name: 'equipment_external_id', type: 'text', nullable: true })
  equipmentExternalId: string | null;

  @Column({ type: 'text', nullable: true })
  name: string | null;
}
