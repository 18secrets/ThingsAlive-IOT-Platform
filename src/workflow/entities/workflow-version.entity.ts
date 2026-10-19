import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WorkflowSpec } from '../workflow-spec';

export type WorkflowVersionStatus = 'draft' | 'published' | 'superseded' | 'retired';
export type WorkflowSource = 'manual' | 'generated';

/**
 * One version of a workflow's execution semantics (task QWF1). A draft is edited in
 * place; a published version is immutable (D05, G13) and the database says so.
 */
@Entity('workflow_version')
@Index('uq_workflow_version', ['tenantId', 'workflowId', 'version'], { unique: true })
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  spec: WorkflowSpec;

  @Column({ name: 'graph_hash', type: 'text' })
  graphHash: string;

  @Column({ type: 'text', default: 'draft' })
  status: WorkflowVersionStatus;

  /** QGEN3 writes 'generated' (D25); everything here writes 'manual'. */
  @Column({ type: 'text', default: 'manual' })
  source: WorkflowSource;

  /** Set by QGEN1's proposals; its foreign key arrives with that table. */
  @Column({ name: 'proposal_id', type: 'uuid', nullable: true })
  proposalId: string | null;

  @Column({ name: 'published_by', type: 'text', nullable: true })
  publishedBy: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
