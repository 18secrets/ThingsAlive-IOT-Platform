import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Where the canvas put each node (task QWF1, G08). Beside the version, never inside its
 * spec: a node dragged across the screen is not a new graph and must not change the
 * hash, the rules or anything the runtime reads.
 */
@Entity('workflow_layout')
export class WorkflowLayout {
  @PrimaryColumn({ name: 'workflow_version_id', type: 'uuid' })
  workflowVersionId: string;

  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'jsonb' })
  positions: Record<string, unknown>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
