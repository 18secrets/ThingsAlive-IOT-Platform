import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** What a tenant pays for on this asset, which decides which tiers it may run. */
export type ServiceTier = 'basic' | 'standard' | 'advanced' | 'full';

/**
 * What 2.0 knows about one piece of equipment that the existing platform does not
 * (task P1-06, reframed).
 *
 * The original task said "alter equipment_master". That was written before 2.0 got
 * its own database, and it is no longer the right shape: `equipment_projection` is a
 * read-only mirror, and writing 2.0 columns into it would make the sync unable to
 * decide whether a differing row had drifted upstream or been edited here. The next
 * full reconcile would then either clobber the tenant's own data or refuse to repair
 * genuine drift.
 *
 * So the class binding, the tier and the readiness record live here, keyed on the
 * same external identity, and the projection stays a faithful copy of its source.
 *
 * Tenant-owned, and therefore covered by row-level security.
 */
@Entity('equipment_profile')
@Index('uq_equipment_profile_external', ['sourceSystem', 'externalId'], { unique: true })
@Index('ix_equipment_profile_tenant', ['tenantId'])
@Index('ix_equipment_profile_class', ['tenantId', 'equipmentClassSlug'])
export class EquipmentProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** The same pair the projection is keyed on. Never a bare upstream integer. */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /**
   * Which catalog class this asset is. Nullable, and the null case is common: an
   * asset nobody has classified yet is the normal state on day one, and a default of
   * "diesel-generator" would silently score a compressor against the wrong failure
   * modes.
   */
  @Column({ name: 'equipment_class_slug', type: 'text', nullable: true })
  equipmentClassSlug: string | null;

  @Column({ name: 'class_version', type: 'int', nullable: true })
  classVersion: number | null;

  @Column({ type: 'text', default: 'basic' })
  tier: ServiceTier;

  @Column({ name: 'commissioned_at', type: 'timestamptz', nullable: true })
  commissionedAt: Date | null;

  @Column({ name: 'service_interval_hours', type: 'int', nullable: true })
  serviceIntervalHours: number | null;

  /**
   * The last computed readiness assessment, cached for listing screens. Derived, not
   * authoritative: the recommendation service recomputes on request, because a cached
   * "ready" that went stale is how an asset appears eligible for a scenario it can no
   * longer run.
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  readiness: Record<string, unknown>;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
