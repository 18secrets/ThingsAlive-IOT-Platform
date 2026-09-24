import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { AlertParams, AlertTrigger } from '../../alert/services/alert-rules';
import { CatalogStatus } from './equipment-class-profile.entity';

/**
 * What Things Alive knows is worth being told about, for a kind of machine (task P1-128).
 *
 * Alerting shipped client-authored, and that was half the model. A client writing their
 * own rules is right — what matters to them is their judgement, not ours. But it meant
 * every new account started with an empty rules list and had to already know that a
 * diesel generator's coolant is interesting at 103 °C rather than at the 110 °C the
 * manufacturer stamped on it. That knowledge is the product. It belongs in the catalog
 * beside the scenarios and the causal chain, not in the customer's homework.
 *
 * Platform-owned, so no `tenant_id`: like every other template table, this is Things
 * Alive's, and a grant is what turns it into rows the client owns. Copied rather than
 * shared, for the same reason the rest of the catalog is copied — a customer whose
 * alerting Things Alive can silently rewrite does not own their alerting.
 *
 * A template carries no plant and no machine, because at authoring time neither exists.
 * It is bound to an equipment class, and the copy lands scoped to that class, which is
 * why `alert_rule` grew a fourth `applies_to`. Without it a rule authored for
 * generators would watch the air compressors too.
 */
@Entity('alert_rule_template')
@Index('uq_alert_rule_template_version', ['slug', 'version'], { unique: true })
@Index('ix_alert_rule_template_class', ['equipmentClassSlug'])
@Index('ix_alert_rule_template_status', ['status'])
export class AlertRuleTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  /** The class this rule is knowledge about. A grant of that class copies it. */
  @Column({ name: 'equipment_class_slug', type: 'text' })
  equipmentClassSlug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text' })
  trigger: AlertTrigger;

  @Column({ type: 'jsonb' })
  params: AlertParams;

  /**
   * How loud it is when it fires, as shipped.
   *
   * A default rather than a decision: the client owns their copy and severity is
   * exactly the kind of thing they will want to change, because how much a hot
   * generator matters depends on whether it is the hospital's or the site office's.
   */
  @Column({ type: 'text', default: Severity.High })
  severity: Severity;

  /**
   * Whether the copy arrives switched on.
   *
   * Some rules are safe to ship live — a machine that went silent for a whole shift is
   * worth a message in any account. Others are noisy until somebody has looked at the
   * fleet, and shipping those enabled would teach a new customer that our alerts are
   * noise, in their first week.
   */
  @Column({ name: 'enabled_on_copy', type: 'boolean', default: true })
  enabledOnCopy: boolean;

  @Column({ type: 'text', default: 'draft' })
  status: CatalogStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
