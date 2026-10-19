import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ProposalKind = 'create_site' | 'create_equipment' | 'fit_logger';
export type ProposalStatus = 'proposed' | 'applied' | 'failed' | 'rejected' | 'expired';

/** One thing the onboarding assistant proposed (task QCHAT2). See `1760700000000-AssistantProposal.ts`. */
@Entity('assistant_proposal')
export class AssistantProposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  kind: ProposalKind;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** The sentence the person approves. Written from the payload, not by the model. */
  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'text', default: 'proposed' })
  status: ProposalStatus;

  @Column({ name: 'proposed_by', type: 'text' })
  proposedBy: string;

  @Column({ name: 'proposed_at', type: 'timestamptz' })
  proposedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'decided_by', type: 'text', nullable: true })
  decidedBy: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
