import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

/**
 * Something wrong with one machine, owned until it is resolved (phase 2, after the
 * closeout's view). Opened by the first alert on a machine with no live incident and
 * gathering every alert after it until resolved; one live incident per machine is a
 * partial unique index (`1760200000000-IncidentEntity.ts`).
 */
@Entity('incident')
@Index('ix_incident_tenant_status', ['tenantId', 'status', 'openedAt'])
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** The worst of its alerts. Rises with a worse alert; never falls. */
  @Column({ type: 'text' })
  severity: Severity;

  @Column({ type: 'text', default: 'open' })
  status: IncidentStatus;

  @Column({ name: 'owner_user_id', type: 'text', nullable: true })
  ownerUserId: string | null;

  @Column({ name: 'opened_at', type: 'timestamptz' })
  openedAt: Date;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ name: 'acknowledged_by', type: 'text', nullable: true })
  acknowledgedBy: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolved_by', type: 'text', nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;

  /** From the account's SLA policy for the severity, at opening. Null: no policy, no clock. */
  @Column({ name: 'ack_due_at', type: 'timestamptz', nullable: true })
  ackDueAt: Date | null;

  @Column({ name: 'resolve_due_at', type: 'timestamptz', nullable: true })
  resolveDueAt: Date | null;

  /** 0 none, 1 acknowledgement overdue, 2 resolution overdue. Only ever rises. */
  @Column({ name: 'escalation_level', type: 'int', default: 0 })
  escalationLevel: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
