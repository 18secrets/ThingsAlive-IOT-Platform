import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Idle with fuel or power available, inside a scheduled shift, for longer than the
 * threshold (task QOEE1). Derived by the detector and never hand-edited — see
 * `1759900000000-Oee.ts` for the trigger that lets a row do nothing but close.
 */
@Entity('breakdown_event')
@Index('uq_breakdown_event_start', ['tenantId', 'sourceSystem', 'externalId', 'startedAt'], { unique: true })
export class BreakdownEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  /** NULL while open: the machine is still idle now, and its minutes count to now. */
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'duration_minutes', type: 'int', nullable: true })
  durationMinutes: number | null;

  @Column({ name: 'shift_id', type: 'uuid', nullable: true })
  shiftId: string | null;

  /** The threshold in force when it was raised — stored, never looked up at read time. */
  @Column({ name: 'threshold_minutes', type: 'int' })
  thresholdMinutes: number;

  /** The two signals and their values when it opened. */
  @Column({ name: 'detected_from', type: 'jsonb' })
  detectedFrom: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
