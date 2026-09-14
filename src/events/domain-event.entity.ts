import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DeliveryState = 'pending' | 'delivered' | 'failed';

/**
 * The transactional outbox (task P1-09's "emits scenario.activated").
 *
 * The event is written in the same transaction as the state change it describes, so
 * the two cannot disagree. Publishing directly to a broker instead would mean a crash
 * between the database commit and the publish loses the event silently — the scenario
 * is active and nothing downstream was ever told, which surfaces weeks later as "why
 * did that machine never get scored".
 *
 * There is no broker yet: P0-16 blocks it. That does not make this premature. The
 * publisher is a loop that reads `pending` rows and marks them `delivered`, and it is
 * the only piece the broker slice adds — everything that produces an event is already
 * correct, and correct at the point where getting it wrong is expensive to discover.
 *
 * Platform-owned deliberately. An outbox is infrastructure: it spans tenants, it is
 * drained by a worker with no request behind it, and a tenant has no business reading
 * or editing the delivery state of a message about them. Their view of the same facts
 * is `scenario_activation_event`, which is theirs and says nothing about delivery.
 */
@Entity('domain_event')
@Index('ix_domain_event_pending', ['deliveryState', 'occurredAt'])
@Index('ix_domain_event_tenant', ['tenantId', 'occurredAt'])
export class DomainEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Dotted and versioned: 'scenario.activated.v1'. The version is part of the name */
  /** because a consumer matching on 'scenario.activated' should not silently start */
  /** receiving a shape it was not written for. */
  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** What the event is about, so a consumer can route without parsing the payload. */
  @Column({ name: 'subject', type: 'text' })
  subject: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /**
   * When the thing happened, which is not when it was delivered and not when it was
   * written. A consumer ordering by delivery time reconstructs a sequence that never
   * occurred.
   */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'delivery_state', type: 'text', default: 'pending' })
  deliveryState: DeliveryState;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** The last failure, kept so a stuck event can be diagnosed without a log search. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
