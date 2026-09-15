import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { AlertParams, AlertTrigger } from '../services/alert-rules';

/**
 * What a rule watches: everything in the account, one site, one machine, or every
 * machine of one class.
 *
 * `equipment-class` arrived with alert templates (task P1-128). A template is authored
 * against a kind of machine and knows no plant and no serial number, so a copied rule
 * has to be able to say "generators" — otherwise a rule written about generators lands
 * in the account watching the air compressors too, fires on machines it was never
 * about, and teaches a new customer in their first week that our alerts are noise.
 */
export type AlertAppliesTo = 'account' | 'plant' | 'equipment' | 'equipment-class';

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

  /** Set when `appliesTo` is `equipment-class`. The client's own copy of the class. */
  @Column({ name: 'equipment_class_slug', type: 'text', nullable: true })
  equipmentClassSlug: string | null;

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

  /**
   * Where this rule came from, or nothing at all.
   *
   * A rule with no `templateSlug` is one the client wrote themselves, and that is not a
   * missing value — it is the answer. It is what lets a screen show "from template",
   * "edited" and "yours" as three different things rather than one list in which the
   * customer cannot tell which of their rules Things Alive will have opinions about.
   */
  @Column({ name: 'template_slug', type: 'text', nullable: true })
  templateSlug: string | null;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'template_checksum', type: 'text', nullable: true })
  templateChecksum: string | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
