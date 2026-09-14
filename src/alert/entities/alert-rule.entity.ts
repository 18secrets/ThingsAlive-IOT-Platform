import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { AlertParams, AlertTrigger } from '../services/alert-rules';

/** What a rule watches: everything in the account, one site, or one machine. */
export type AlertAppliesTo = 'account' | 'plant' | 'equipment';

/**
 * A rule the client wrote, saying what they want to be told about (task P1-119).
 *
 * Alerts are 2.0's, not the existing platform's: Things Alive settled that alerting is
 * enabled from the new version, so nothing here mirrors or reads their alert table.
 *
 * The distinction worth holding on to is between a prediction, an alert and a job. A
 * prediction is what the scorer computed. An alert is a standing request from the
 * customer to be told when something is true — their judgement about what matters,
 * which is not ours to guess. A job is work somebody does. All three exist because
 * collapsing any two of them loses something: an alert with no rule behind it is a
 * notification nobody asked for, and a job raised for every alert is a queue.
 *
 * Scoped the same three ways a role is, on purpose. A site manager writing a rule for
 * their own plant and a CEO writing one for the account are the same act at different
 * widths, and inventing a second vocabulary for it would mean two things to learn.
 */
@Entity('alert_rule')
@Index('uq_alert_rule_slug', ['tenantId', 'slug'], { unique: true })
@Index('ix_alert_rule_tenant', ['tenantId', 'enabled'])
export class AlertRule {
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

  @Column({ type: 'text' })
  trigger: AlertTrigger;

  /**
   * The rule's settings, shaped by its trigger and validated on every write.
   *
   * jsonb rather than a column per trigger, because the three kinds share almost
   * nothing and a table of mostly-null columns describes none of them well. The cost
   * is that the database cannot check the shape, which is why the service does, once,
   * in one place.
   */
  @Column({ type: 'jsonb' })
  params: AlertParams;

  @Column({ name: 'applies_to', type: 'text', default: 'account' })
  appliesTo: AlertAppliesTo;

  @Column({ name: 'plant_id', type: 'uuid', nullable: true })
  plantId: string | null;

  @Column({ name: 'source_system', type: 'text', nullable: true })
  sourceSystem: string | null;

  @Column({ name: 'external_id', type: 'text', nullable: true })
  externalId: string | null;

  /** How loud this is when it fires. The client's judgement, not the scorer's. */
  @Column({ type: 'text', default: 'high' })
  severity: Severity;

  /**
   * Switched off rather than deleted.
   *
   * Alert events point at the rule that raised them; deleting it would leave a history
   * of alerts nobody can explain, which is the same reason a shift is retired and a
   * user is suspended.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
