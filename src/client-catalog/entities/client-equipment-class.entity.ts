import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ExpectedSignal, FailureMode } from '../../catalog/entities/equipment-class-profile.entity';

export type ClientCatalogStatus = 'active' | 'archived';

/**
 * A client's own copy of an equipment class, created when the class is granted.
 *
 * The catalog is a **template library**. Granting a class copies it here, and from
 * that moment the copy belongs to the client: their super admin may rewrite any of
 * it, and Things Alive cannot write to it at all. A master admin can read it — under
 * the audited cross-tenant path — because support has to see what is actually
 * running, but that is the whole of their access.
 *
 * Two consequences follow from the copy being a fork, and both are handled by the
 * provenance columns below rather than wished away:
 *
 * 1. A correction Things Alive publishes to the template does not reach this copy.
 *    `templateSlug` and `templateVersion` record what it was forked from, so a newer
 *    template can be *offered*, and the client decides. Pushing it would be Things
 *    Alive editing a client's settings, which is exactly what this model forbids.
 *
 * 2. Support ends up debugging a definition they have never seen. `templateChecksum`
 *    is the hash of the template at the moment of copying: comparing it against this
 *    row's current content answers "has this been edited, and therefore is it still
 *    the thing we shipped" without anybody having to remember.
 */
@Entity('client_equipment_class')
@Index('uq_client_equipment_class', ['tenantId', 'slug'], { unique: true })
@Index('ix_client_equipment_class_tenant', ['tenantId'])
export class ClientEquipmentClass {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** The client's own identifier. Starts as the template's slug; they may rename it. */
  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  category: string | null;

  @Column({ name: 'expected_signals', type: 'jsonb', default: () => `'[]'::jsonb` })
  expectedSignals: ExpectedSignal[];

  @Column({ name: 'failure_modes', type: 'jsonb', default: () => `'[]'::jsonb` })
  failureModes: FailureMode[];

  @Column({ name: 'default_thresholds', type: 'jsonb', default: () => `'{}'::jsonb` })
  defaultThresholds: Record<string, unknown>;

  /**
   * Where this came from. Null for a class the client invented themselves, which is
   * a different thing from one that was copied and then rewritten — and support will
   * want to tell them apart.
   */
  @Column({ name: 'template_slug', type: 'text', nullable: true })
  templateSlug: string | null;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  /** Hash of the template content at the moment of copying. See the class comment. */
  @Column({ name: 'template_checksum', type: 'text', nullable: true })
  templateChecksum: string | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @Column({ type: 'text', default: 'active' })
  status: ClientCatalogStatus;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
