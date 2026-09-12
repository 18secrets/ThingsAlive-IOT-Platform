import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Which equipment classes a tenant has been granted (task P1-04).
 *
 * The catalog itself is global; this table is what makes a tenant's view of it
 * narrow. Every catalog read from a tenant context joins through here, so an
 * unentitled class is not "hidden in the UI" — it does not come back from the API,
 * and a request for it by slug is a 404 rather than a 403. A 403 would confirm the
 * class exists, which is commercial information about what Things Alive sells and to
 * whom.
 *
 * Revoked rather than deleted: a grant that existed and was withdrawn is a different
 * fact from one that never existed, and the first is the one somebody asks about.
 */
@Entity('client_catalog_entitlement')
@Index('uq_client_catalog_entitlement', ['tenantId', 'equipmentClassSlug'], { unique: true })
@Index('ix_client_catalog_entitlement_tenant', ['tenantId'])
export class ClientCatalogEntitlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'equipment_class_slug', type: 'text' })
  equipmentClassSlug: string;

  /** Who granted it. A commercial decision should have a name attached. */
  @Column({ name: 'granted_by', type: 'text' })
  grantedBy: string;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_by', type: 'text', nullable: true })
  revokedBy: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
