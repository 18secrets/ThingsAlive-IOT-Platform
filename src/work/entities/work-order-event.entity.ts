import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WorkOrderStatus } from '../services/work-order-state-machine';

export type WorkOrderEventKind = 'raised' | 'assigned' | 'unassigned' | 'started'
  | 'completed' | 'cancelled' | 'reopened' | 'edited';

/**
 * What happened to a job, and who did it (task P1-87).
 *
 * Separate from the work order rather than a jsonb column on it, for the reason every
 * history in this codebase is separate: the row is what is true now and the history is
 * what was true, and a system that keeps both in one place ends up keeping neither.
 *
 * Written in the same transaction as the change it describes, so the two cannot
 * disagree about whether something happened.
 */
@Entity('work_order_event')
@Index('ix_work_order_event_order', ['tenantId', 'workOrderId', 'at'])
export class WorkOrderEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'work_order_id', type: 'uuid' })
  workOrderId: string;

  @Column({ type: 'text' })
  kind: WorkOrderEventKind;

  @Column({ name: 'from_status', type: 'text', nullable: true })
  fromStatus: WorkOrderStatus | null;

  @Column({ name: 'to_status', type: 'text', nullable: true })
  toStatus: WorkOrderStatus | null;

  @Column({ name: 'from_assignee', type: 'uuid', nullable: true })
  fromAssignee: string | null;

  @Column({ name: 'to_assignee', type: 'uuid', nullable: true })
  toAssignee: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'actor_user_id', type: 'text' })
  actorUserId: string;

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
