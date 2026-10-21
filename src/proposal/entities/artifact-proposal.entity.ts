import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { GateOutcome, ProposalKind, ProposalScope, ProposalStatus } from '../proposal-kinds';

/** One generated draft and every step it has been through (task QGEN1). See `1761800000000-ArtifactProposal.ts`. */
@Entity('artifact_proposal')
export class ArtifactProposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  kind: ProposalKind;

  @Column({ type: 'text', default: 'tenant' })
  scope: ProposalScope;

  @Column({ type: 'text', default: 'proposed' })
  status: ProposalStatus;

  /** The person's typed selection. Never free text (D25). */
  @Column({ type: 'jsonb' })
  seed: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  target: Record<string, unknown>;

  @Column({ name: 'target_versions', type: 'jsonb' })
  targetVersions: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'proposal_hash', type: 'text' })
  proposalHash: string;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ type: 'text', default: 'generated' })
  source: 'generated';

  @Column({ name: 'emitter_kind', type: 'text' })
  emitterKind: string;

  @Column({ name: 'emitter_version', type: 'text' })
  emitterVersion: string;

  /** Set only when a model contributed (question 4); a deterministic emitter leaves both null. */
  @Column({ name: 'model_id', type: 'text', nullable: true })
  modelId: string | null;

  @Column({ name: 'model_version', type: 'text', nullable: true })
  modelVersion: string | null;

  @Column({ name: 'recommendation_id', type: 'uuid', nullable: true })
  recommendationId: string | null;

  @Column({ name: 'evidence_bundle_id', type: 'uuid', nullable: true })
  evidenceBundleId: string | null;

  @Column({ name: 'evidence_hash', type: 'text', nullable: true })
  evidenceHash: string | null;

  @Column({ name: 'compile_result', type: 'jsonb', nullable: true })
  compileResult: Record<string, unknown> | null;

  @Column({ name: 'gate_outcome', type: 'text', nullable: true })
  gateOutcome: GateOutcome | null;

  @Column({ name: 'gate_detail', type: 'jsonb', nullable: true })
  gateDetail: Record<string, unknown> | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'proposed_by', type: 'text' })
  proposedBy: string;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'rejected_by', type: 'text', nullable: true })
  rejectedBy: string | null;

  @Column({ name: 'rejected_at', type: 'timestamptz', nullable: true })
  rejectedAt: Date | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ name: 'materialised_ref', type: 'jsonb', nullable: true })
  materialisedRef: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
