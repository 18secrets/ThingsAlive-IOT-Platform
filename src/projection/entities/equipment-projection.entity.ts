import { Column, Entity, Index } from 'typeorm';
import { ProjectionBase } from './projection-base';

@Entity('equipment_projection')
@Index('uq_equipment_projection_external', ['sourceSystem', 'externalId'], { unique: true })
@Index('ix_equipment_projection_tenant', ['tenantId'])
export class EquipmentProjection extends ProjectionBase {
  @Column({ type: 'text', nullable: true })
  name: string | null;

  /** The equipment class this asset belongs to, once the catalog is populated. */
  @Column({ name: 'class_id', type: 'text', nullable: true })
  classId: string | null;

  @Column({ name: 'plant_external_id', type: 'text', nullable: true })
  plantExternalId: string | null;

  @Column({ name: 'category', type: 'text', nullable: true })
  category: string | null;
}
