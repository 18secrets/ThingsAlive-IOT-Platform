import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { Blocker } from '../../catalog/services/recommendation.service';

/**
 * Where a scenario is in its life on one asset (task P1-09).
 *
 * `proposed` is the recommendation engine's suggestion, not yet acted on. `active`
 * means it scores. `paused` is off with the intent of coming back — a site under
 * maintenance, an alert storm being investigated. `deactivated` is off for good, and
 * still a row, because the first question after an alert stops arriving is when
 * somebody turned it off and why.
 */
export type ActivationState = 'proposed' | 'active' | 'paused' | 'deactivated';

/**
 * One scenario, running on one piece of equipment (task P1-09).
 *
 * Three layers of parameters resolve into what actually scores: the scenario
 * definition's declared defaults, the client's own edits to their copy, and the
 * per-asset overrides here. The third layer exists because a set in a hot plant room
 * legitimately needs a different warning point from the identical set outdoors, and
 * without it the client's only options are to edit the scenario for the whole fleet
 * or to clone it — and a fleet of near-identical clones is how a catalog becomes
 * unmaintainable.
 *
 * Tenant-owned, so an activation cannot be written into an account that is not the
 * session's own.
 */
@Entity('equipment_scenario')
@Index('uq_equipment_scenario', ['tenantId', 'sourceSystem', 'externalId', 'clientScenarioSlug'], { unique: true })
@Index('ix_equipment_scenario_state', ['tenantId', 'state'])
@Index('ix_equipment_scenario_scenario', ['tenantId', 'clientScenarioSlug'])
export class EquipmentScenario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** The asset, by the same external identity the projection is keyed on. */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** The client's own scenario, not a Things Alive template. */
  @Column({ name: 'client_scenario_slug', type: 'text' })
  clientScenarioSlug: string;

  @Column({ type: 'text', default: 'proposed' })
  state: ActivationState;

  /**
   * Per-asset overrides, keyed by parameter. Sparse: only what differs from the
   * client scenario. Storing the full set would make a later change to the scenario
   * silently fail to reach assets that had been tuned, which is the opposite of what
   * anyone tuning one asset intends.
   */
  @Column({ name: 'parameter_overrides', type: 'jsonb', default: () => `'{}'::jsonb` })
  parameterOverrides: Record<string, unknown>;

  /**
   * What was stopping this scenario at the moment it was activated.
   *
   * Empty for a clean activation. Non-empty when the client activated something that
   * cannot fire yet — a sensor still to be fitted, a baseline still accumulating.
   * Recorded rather than refused, because "activated, waiting on the coolant sensor"
   * is a true and useful thing for a screen to say, and an activation that looks
   * healthy while scoring nothing is not.
   */
  @Column({ name: 'blockers_at_activation', type: 'jsonb', default: () => `'[]'::jsonb` })
  blockersAtActivation: Blocker[];

  @Column({ name: 'activated_by', type: 'text', nullable: true })
  activatedBy: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ name: 'state_changed_by', type: 'text', nullable: true })
  stateChangedBy: string | null;

  @Column({ name: 'state_changed_at', type: 'timestamptz', nullable: true })
  stateChangedAt: Date | null;

  /** Why it was paused or deactivated. Required on those transitions. */
  @Column({ name: 'state_reason', type: 'text', nullable: true })
  stateReason: string | null;

  /**
   * When the scorer last looked at this. Null while nothing has run it — which,
   * next to state = 'active', is precisely the "switched on but silent" case worth
   * surfacing rather than leaving for somebody to notice.
   */
  @Column({ name: 'last_evaluated_at', type: 'timestamptz', nullable: true })
  lastEvaluatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
