import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ZoneKind, ZoneShape } from '../geometry';

/** The same four targets an alert rule has. */
export type ZoneAppliesTo = 'account' | 'plant' | 'equipment' | 'equipment-class';

/**
 * A geofence zone, owned by the client (task QGEO2). Its shape, its target and the match
 * between kind and shape are the database's to hold — see GeofenceZones1762800000000.
 * Code and target never change after creation; a different target is a different zone.
 */
@Entity('geofence_zone')
@Index('uq_geofence_zone_code', ['tenantId', 'code'], { unique: true })
export class GeofenceZone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  kind: ZoneKind;

  @Column({ type: 'jsonb' })
  shape: ZoneShape;

  @Column({ name: 'applies_to', type: 'text' })
  appliesTo: ZoneAppliesTo;

  @Column({ name: 'plant_id', type: 'uuid', nullable: true })
  plantId: string | null;

  @Column({ name: 'source_system', type: 'text', nullable: true })
  sourceSystem: string | null;

  @Column({ name: 'external_id', type: 'text', nullable: true })
  externalId: string | null;

  @Column({ name: 'equipment_class_slug', type: 'text', nullable: true })
  equipmentClassSlug: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
