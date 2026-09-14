import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PlantStatus = 'active' | 'retired';

/**
 * A site, owned by the client (task P1-85).
 *
 * The existing platform has plants too, and this is not a mirror of them. The
 * decision that produced this table is that the client's own CEO or manager owns
 * where their machines are — which means placement is 2.0's to write, and a read-only
 * projection cannot hold something a customer edits.
 *
 * `externalId` records the upstream site a plant corresponds to, when it corresponds
 * to one at all. It is how a fleet that already exists upstream is adopted without
 * being retyped, and how scope keeps working for equipment that has not been adopted
 * yet. Nullable, because a site created here has no upstream counterpart and never
 * needs one.
 */
@Entity('plant')
@Index('uq_plant_code', ['tenantId', 'code'], { unique: true })
@Index('ix_plant_tenant', ['tenantId', 'status'])
export class Plant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /**
   * The client's own short name for the site, unique within their account.
   *
   * A uuid is the key everything joins on; this is what a person types and what
   * appears on a work order. Separating the two means a customer can rename a site
   * without breaking every row that points at it.
   */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ name: 'site_area', type: 'text', nullable: true })
  siteArea: string | null;

  @Column({ type: 'text', nullable: true })
  capacity: string | null;

  @Column({ name: 'project_type', type: 'text', nullable: true })
  projectType: string | null;

  @Column({ name: 'operational_status', type: 'text', nullable: true })
  operationalStatus: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: 'active' })
  status: PlantStatus;

  /** The upstream site this one corresponds to, when it corresponds to one. */
  @Column({ name: 'source_system', type: 'text', nullable: true })
  sourceSystem: string | null;

  @Column({ name: 'external_id', type: 'text', nullable: true })
  externalId: string | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
