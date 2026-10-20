import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Somebody chose to switch on a rule that was generated without enough history (QGEN1 question 8). */
@Entity('proposal_rule_enablement')
export class ProposalRuleEnablement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'alert_rule_id', type: 'uuid' })
  alertRuleId: string;

  @Column({ name: 'proposal_id', type: 'uuid' })
  proposalId: string;

  @Column({ name: 'enabled_by', type: 'text' })
  enabledBy: string;

  @Column({ name: 'enabled_at', type: 'timestamptz' })
  enabledAt: Date;

  /** The history check as it stood when they chose to. */
  @Column({ type: 'jsonb' })
  history: Record<string, unknown>;
}
