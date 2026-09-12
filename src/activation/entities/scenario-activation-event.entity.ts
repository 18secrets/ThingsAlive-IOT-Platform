import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Blocker } from '../../catalog/services/recommendation.service';
import { ActivationState } from './equipment-scenario.entity';
import { ActivationAction } from '../services/state-machine';

/**
 * The client's own history of turning scenarios on and off (task P1-09's audit row).
 *
 * Separate from the outbox, and the separation is deliberate. This is a record the
 * customer reads: who turned this off, when, and what reason they gave. The outbox is
 * a queue a worker drains and eventually prunes, carrying delivery state no tenant
 * should see. Folding them together would mean either exposing retry counts on a
 * customer screen or pruning the answer to "when did somebody turn this off", and
 * both are worse than a second table.
 *
 * Tenant-owned and append-only in practice: the point of a history is that it is not
 * edited afterwards.
 */
@Entity('scenario_activation_event')
@Index('ix_activation_event_asset', ['tenantId', 'sourceSystem', 'externalId', 'at'])
@Index('ix_activation_event_scenario', ['tenantId', 'clientScenarioSlug', 'at'])
export class ScenarioActivationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'client_scenario_slug', type: 'text' })
  clientScenarioSlug: string;

  @Column({ type: 'text' })
  action: ActivationAction;

  /** Null on the first transition, because there was no state to come from. */
  @Column({ name: 'from_state', type: 'text', nullable: true })
  fromState: ActivationState | null;

  @Column({ name: 'to_state', type: 'text' })
  toState: ActivationState;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /**
   * What was stopping it at the moment of the transition. Kept per event rather than
   * only on the current row, so "it was activated while the sensor was still missing"
   * remains answerable after the sensor is fitted and the row looks clean.
   */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  blockers: Blocker[];

  @Column({ name: 'actor_user_id', type: 'text' })
  actorUserId: string;

  @Column({ name: 'actor_roles', type: 'text', array: true, default: () => `'{}'::text[]` })
  actorRoles: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}
