import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** What a tenant pays for on this asset, which decides which tiers it may run. */
export type ServiceTier = 'basic' | 'standard' | 'advanced' | 'full';

/** Adopted from the existing platform's records, or created here by the customer. */
export type EquipmentOrigin = 'mirrored' | 'client';

export type EquipmentStatus = 'active' | 'retired';

/** The source system stamped on equipment a customer creates in 2.0. */
export const CLIENT_SOURCE_SYSTEM = 'ta-2.0';

/**
 * The equipment register (tasks P1-06, P1-85).
 *
 * This started as a set of 2.0-owned annotations hanging off a read-only mirror. It
 * is now the register itself: the client's own CEO or manager creates equipment here,
 * names it, places it at a site and moves it between sites. The mirror is still
 * mirrored and still read-only; what changed is which side is authoritative about
 * the things a customer edits.
 *
 * Identity is unchanged, and that is what made the change cheap. The key was always
 * `(source_system, external_id)` because two upstream systems could legitimately
 * report the same machine — so equipment created in 2.0 is simply another source
 * system, and every consumer built over the last twelve slices keeps working without
 * knowing the difference.
 *
 * The original note on why this is not a column inside the mirror still applies:
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

  /**
   * Whether this row was adopted from the mirror or created here.
   *
   * Kept because the two behave differently on reconcile: an upstream change to a
   * mirrored asset is news, and an upstream row that looks like a client-created one
   * is a coincidence of identifiers rather than the same machine.
   */
  @Column({ type: 'text', default: 'client' })
  origin: EquipmentOrigin;

  @Column({ type: 'text', default: 'active' })
  status: EquipmentStatus;

  @Column({ type: 'text', nullable: true })
  name: string | null;

  @Column({ type: 'text', nullable: true })
  manufacturer: string | null;

  @Column({ name: 'model_number', type: 'text', nullable: true })
  modelNumber: string | null;

  @Column({ name: 'serial_number', type: 'text', nullable: true })
  serialNumber: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Which site this machine is at, as 2.0 understands it.
   *
   * The mirror has its own answer and they can disagree; this one wins, because the
   * customer's manager is the person who moves machines and this is where they say
   * so. A site manager's view of their fleet is derived from this column, which is
   * why changing it is recorded rather than simply applied.
   */
  @Column({ name: 'plant_id', type: 'uuid', nullable: true })
  plantId: string | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
