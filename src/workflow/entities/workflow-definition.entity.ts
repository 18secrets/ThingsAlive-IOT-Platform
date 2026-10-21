import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** `alert` executes through the compiler; `agent` waits for a runtime (D16). */
export type WorkflowKind = 'alert';

/**
 * A workflow: what a person names and edits (task QWF1). Its content lives in
 * versions; this row is the identity the versions and the compiled rules point at.
 * See `1760800000000-WorkflowCompiler.ts`.
 */
@Entity('workflow_definition')
@Index('uq_workflow_definition_slug', ['tenantId', 'slug'], { unique: true })
export class WorkflowDefinition {
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

  @Column({ type: 'text', default: 'alert' })
  kind: WorkflowKind;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
