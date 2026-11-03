import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** Flat areas, drawn as coloured ground. */
export const AREA_KINDS = ['work_area', 'material_yard', 'parking', 'restricted'] as const;
/** Structures, drawn in 3-D inside their rectangle. */
export const STRUCTURE_KINDS = [
  'head_office', 'site_office', 'batching_plant', 'maintenance_workshop', 'gate', 'road',
  'building', 'substation', 'quay', 'container_yard', 'quay_crane_berth',
] as const;
/** The database holds the same list (`ck_site_twin_zone_kind`). */
export const ZONE_KINDS = [...AREA_KINDS, ...STRUCTURE_KINDS] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
/** What is built in stages, and so can report progress (`ck_site_twin_zone_progress`). */
export const PROGRESS_KINDS: readonly ZoneKind[] = ['building', 'road', 'substation', 'quay'];

/** A site's layout header: its extent in metres and the layout's optimistic-lock version.
 * Migration `1762100000000-SiteTwin` has the rules. */
@Entity('site_twin')
export class SiteTwin {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ name: 'plant_id', type: 'uuid' })
  plantId: string;

  @Column({ name: 'width_m', type: 'double precision' })
  widthM: number;

  @Column({ name: 'depth_m', type: 'double precision' })
  depthM: number;

  @Column({ type: 'int', default: 0 })
  version: number;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/** A rectangle on the ground, centred at (x, z). */
@Entity('site_twin_zone')
export class SiteTwinZone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'plant_id', type: 'uuid' })
  plantId: string;

  @Column({ type: 'text' })
  key: string;

  @Column({ type: 'text' })
  label: string;

  @Column({ type: 'text' })
  kind: ZoneKind;

  @Column({ type: 'double precision' })
  x: number;

  @Column({ type: 'double precision' })
  z: number;

  @Column({ name: 'width_m', type: 'double precision' })
  widthM: number;

  @Column({ name: 'depth_m', type: 'double precision' })
  depthM: number;

  @Column({ type: 'int', nullable: true })
  floors: number | null;

  @Column({ name: 'progress_pct', type: 'double precision', nullable: true })
  progressPct: number | null;

  @Column({ name: 'progress_reported_at', type: 'timestamptz', nullable: true })
  progressReportedAt: Date | null;

  @Column({ name: 'progress_reported_by', type: 'text', nullable: true })
  progressReportedBy: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}

/** Where one machine stands on one site, and which way it faces. */
@Entity('site_twin_placement')
export class SiteTwinPlacement {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ name: 'plant_id', type: 'uuid' })
  plantId: string;

  @PrimaryColumn({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @PrimaryColumn({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ type: 'double precision' })
  x: number;

  @Column({ type: 'double precision' })
  z: number;

  @Column({ name: 'heading_deg', type: 'double precision', default: 0 })
  headingDeg: number;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  route: string[];
}

export const SITE_TWIN_ENTITIES = [SiteTwin, SiteTwinZone, SiteTwinPlacement];
