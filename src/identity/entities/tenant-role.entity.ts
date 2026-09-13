import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Capability } from '../../auth/capabilities';

/**
 * How a role narrows what its holder can see.
 *
 * Not a permission level — a shape. The three roles a client starts with differ in
 * kind rather than in degree: one is unrestricted, one is a list of sites, one is a
 * list of machines. Storing "how much access" as a number would collapse that.
 */
export type ScopeShape = 'tenant' | 'plant' | 'equipment';

/**
 * A role, owned by the client (tasks P1-21, P1-83).
 *
 * Roles are rows and capabilities are code, and the split is the point. A client can
 * add roles — they were always going to need more than three — but they compose them
 * from a fixed vocabulary the application actually checks. A role naming a capability
 * that no code reads would be a permission that silently does nothing, which is the
 * worst kind: it looks granted.
 *
 * Things Alive ships three as templates and the copy lands here, exactly as an
 * equipment class does. After that the client owns it: rename it, add a capability,
 * delete it. Editing a template never reaches into an account.
 */
@Entity('tenant_role')
@Index('uq_tenant_role', ['tenantId', 'slug'], { unique: true })
export class TenantRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Validated against the capability union on every write. Stored as text because
   * Postgres cannot hold a TypeScript union, which makes the check a service's job
   * rather than the schema's — so it is written once, in one place.
   */
  @Column({ type: 'text', array: true, default: () => `'{}'::text[]` })
  capabilities: Capability[];

  @Column({ name: 'scope_shape', type: 'text', default: 'equipment' })
  scopeShape: ScopeShape;

  /**
   * A role the account cannot delete, because deleting it would strand its holders
   * with no role at all. It can still be renamed and re-scoped: it is the client's.
   */
  @Column({ name: 'is_built_in', type: 'boolean', default: false })
  isBuiltIn: boolean;

  @Column({ name: 'template_slug', type: 'text', nullable: true })
  templateSlug: string | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
