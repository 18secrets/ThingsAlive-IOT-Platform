import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { WorkOrderStatus } from '../services/work-order-state-machine';

export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * A job on a machine (task P1-87).
 *
 * Work orders stopped being load-bearing for access the moment assignment became a
 * standing thing: an operator sees a machine because it is assigned to them, not
 * because a job is open on it. That makes this an ordinary feature rather than a
 * permission system wearing a maintenance hat, and it is why closing a job takes
 * nothing away from anybody.
 *
 * There is no work-order module in the existing platform, so nothing is mirrored here
 * and nothing is written back: this table is 2.0's own.
 */
@Entity('work_order')
@Index('uq_work_order_reference', ['tenantId', 'reference'], { unique: true })
@Index('ix_work_order_asset', ['tenantId', 'sourceSystem', 'externalId'])
@Index('ix_work_order_assignee', ['tenantId', 'assignedToUserId'])
export class WorkOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /**
   * What people call it out loud: WO-000041.
   *
   * Numbered per account from the account's own counter rather than from one shared
   * sequence. A shared sequence would be simpler and would leak: a customer watching
   * their own numbers jump from 12 to 4,310 learns how much work every other customer
   * is raising.
   */
  @Column({ type: 'text' })
  reference: string;

  /** The machine, keyed exactly as everything else keys one. */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: 'created' })
  status: WorkOrderStatus;

  @Column({ type: 'text', default: 'normal' })
  priority: WorkOrderPriority;

  /**
   * Who is to do it, or nobody yet.
   *
   * A field rather than a status. Making "assigned" a state sounds tidier until the
   * first job that is being worked on by somebody who was never formally assigned, or
   * the first assigned job that is cancelled — both become unrepresentable, and the
   * usual fix is a status that lies.
   */
  @Column({ name: 'assigned_to_user_id', type: 'uuid', nullable: true })
  assignedToUserId: string | null;

  /**
   * The prediction that caused this, when one did.
   *
   * The whole platform is an argument that a number on a screen should turn into
   * somebody with a spanner. Without this column that argument cannot be checked:
   * "how many of our warnings did anyone act on" is the question the product is
   * ultimately judged by, and it is unanswerable if the link is only in a title.
   */
  @Column({ name: 'prediction_id', type: 'uuid', nullable: true })
  predictionId: string | null;

  @Column({ name: 'due_at', type: 'timestamptz', nullable: true })
  dueAt: Date | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /** What was actually done. Required to complete; see the state machine. */
  @Column({ type: 'text', nullable: true })
  resolution: string | null;

  @Column({ name: 'raised_by', type: 'text' })
  raisedBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * One account's counter, so references are per-account and contiguous.
 *
 * Its own table rather than a column on `tenant`, because it is written on every
 * raise and a row lock on the account record would serialise things that have nothing
 * to do with each other.
 */
@Entity('work_order_counter')
export class WorkOrderCounter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'next_number', type: 'integer', default: 1 })
  nextNumber: number;
}
