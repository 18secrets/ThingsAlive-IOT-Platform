import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { Severity } from '../../common/severity';

/** Which alerts an incident gathered. An alert is in at most one. */
@Entity('incident_alert')
export class IncidentAlert {
  @PrimaryColumn({ name: 'incident_id', type: 'uuid' })
  incidentId: string;

  @PrimaryColumn({ name: 'alert_event_id', type: 'uuid' })
  alertEventId: string;

  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'linked_at', type: 'timestamptz' })
  linkedAt: Date;
}

export type IncidentEventKind =
  | 'opened' | 'alert_linked' | 'severity_raised' | 'acknowledged' | 'assigned' | 'work_raised'
  | 'escalated' | 'resolved';

/** The timeline. Append-only, by trigger as well as by grant. */
@Entity('incident_event')
export class IncidentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'incident_id', type: 'uuid' })
  incidentId: string;

  @Column({ type: 'text' })
  kind: IncidentEventKind;

  /** A user id, or `system` for what the platform did on its own. */
  @Column({ type: 'text' })
  actor: string;

  @Column({ type: 'timestamptz' })
  at: Date;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  detail: Record<string, unknown>;
}

/** Minutes to acknowledge and to resolve, per account and severity. No defaults. */
@Entity('incident_sla_policy')
export class IncidentSlaPolicy {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ type: 'text' })
  severity: Severity;

  @Column({ name: 'ack_within_minutes', type: 'int' })
  ackWithinMinutes: number;

  @Column({ name: 'resolve_within_minutes', type: 'int' })
  resolveWithinMinutes: number;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
