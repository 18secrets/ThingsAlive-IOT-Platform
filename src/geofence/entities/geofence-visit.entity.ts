import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ZoneKind } from '../geometry';

export type VisitLeftReason = 'exited' | 'zone_removed';

/**
 * A stretch of time a machine spent inside a zone (task QGEO2, stage 2). Derived from
 * readings on shift boundaries and derived again when a late reading rewinds a shift —
 * see GeofenceVisits1762900000000 for what the database holds whatever the derivation does.
 */
@Entity('geofence_visit')
@Index('uq_geofence_visit_entry', ['tenantId', 'sourceSystem', 'externalId', 'zoneKey', 'enteredAt'], { unique: true })
export class GeofenceVisit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** `zone:<id>`, or `site:<plant id>` for a site boundary. */
  @Column({ name: 'zone_key', type: 'text' })
  zoneKey: string;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ name: 'zone_source', type: 'text' })
  zoneSource: 'zone' | 'site-boundary';

  @Column({ name: 'zone_code', type: 'text' })
  zoneCode: string;

  @Column({ name: 'zone_name', type: 'text' })
  zoneName: string;

  @Column({ name: 'zone_kind', type: 'text' })
  zoneKind: ZoneKind;

  @Column({ name: 'entered_at', type: 'timestamptz' })
  enteredAt: Date;

  @Column({ name: 'entry_lng', type: 'double precision' })
  entryLng: number;

  @Column({ name: 'entry_lat', type: 'double precision' })
  entryLat: number;

  @Column({ name: 'left_at', type: 'timestamptz', nullable: true })
  leftAt: Date | null;

  @Column({ name: 'exit_lng', type: 'double precision', nullable: true })
  exitLng: number | null;

  @Column({ name: 'exit_lat', type: 'double precision', nullable: true })
  exitLat: number | null;

  @Column({ name: 'left_reason', type: 'text', nullable: true })
  leftReason: VisitLeftReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
