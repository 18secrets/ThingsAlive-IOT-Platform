import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Severity } from '../../common/severity';

export type AlertState = 'open' | 'acknowledged' | 'resolved';

/**
 * A rule that fired, and what was true when it did (task P1-119).
 *
 * The evidence column is the part that earns its place. An alert that says a machine
 * is in trouble and cannot say why is worse than no alert at all: somebody walks out
 * to the machine, finds nothing obvious, and trusts the next one less. By the time
 * anybody opens this, the readings behind it have been superseded — so what was true
 * is captured at the moment of firing rather than looked up afterwards.
 *
 * Acknowledged is deliberately distinct from resolved. "I have seen this" and "this is
 * dealt with" are different claims made by different people at different times, and a
 * system with only one of them makes somebody choose which lie to tell.
 */
@Entity('alert_event')
@Index('ix_alert_event_tenant', ['tenantId', 'firedAt'])
@Index('ix_alert_event_asset', ['tenantId', 'sourceSystem', 'externalId', 'firedAt'])
@Index('ix_alert_event_rule', ['tenantId', 'ruleId', 'state'])
export class AlertEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'rule_id', type: 'uuid' })
  ruleId: string;

  /**
   * The rule's name as it read when this fired.
   *
   * Copied rather than joined. A client who renames a rule has not changed what
   * happened last March, and a history that silently re-labels itself when somebody
   * edits a rule is a history nobody can rely on.
   */
  @Column({ name: 'rule_name', type: 'text' })
  ruleName: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ type: 'text' })
  severity: Severity;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  evidence: Record<string, unknown>;

  /** The shift this was about, named the way the plant names it. */
  @Column({ name: 'shift_local_date', type: 'text', nullable: true })
  shiftLocalDate: string | null;

  @Column({ name: 'window_start', type: 'timestamptz', nullable: true })
  windowStart: Date | null;

  @Column({ name: 'window_end', type: 'timestamptz', nullable: true })
  windowEnd: Date | null;

  @Column({ name: 'prediction_id', type: 'uuid', nullable: true })
  predictionId: string | null;

  @Column({ type: 'text', default: 'open' })
  state: AlertState;

  @Column({ name: 'acknowledged_by', type: 'text', nullable: true })
  acknowledgedBy: string | null;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ name: 'resolved_by', type: 'text', nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;

  @CreateDateColumn({ name: 'fired_at', type: 'timestamptz' })
  firedAt: Date;
}
