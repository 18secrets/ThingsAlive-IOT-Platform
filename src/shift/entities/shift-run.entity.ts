import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ShiftRunStatus = 'scored' | 'nothing-to-score' | 'not-running' | 'failed';

/**
 * What the runner did to one shift window, and what it could not do (task P1-115).
 *
 * "Why has this machine not been scored since Tuesday" is the first question anybody
 * asks about a scheduled job, and until this table existed the only answer was in the
 * logs — which is to say, available to whoever has access to the logs, for as long as
 * the logs are kept, and to nobody on a screen.
 *
 * Every outcome is recorded, not just the failures. A window that was skipped because
 * the machine never ran is the explanation somebody needs; if only failures were kept,
 * the absence of a row would mean either "it worked" or "nothing happened", and those
 * are the two answers that most need telling apart.
 */
@Entity('shift_run')
@Index('ix_shift_run_asset', ['tenantId', 'sourceSystem', 'externalId', 'ranAt'])
@Index('ix_shift_run_shift', ['tenantId', 'shiftId', 'ranAt'])
export class ShiftRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'shift_id', type: 'uuid' })
  shiftId: string;

  /** The shift's name as it read at the time, for the same reason an alert copies it. */
  @Column({ name: 'shift_name', type: 'text' })
  shiftName: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** The day the plant calls it. */
  @Column({ name: 'local_date', type: 'text' })
  localDate: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd: Date;

  @Column({ type: 'text' })
  status: ShiftRunStatus;

  /**
   * Why, in one word, when the status alone does not say.
   *
   * `no-devices` and `no-sensors` are a commissioning gap and a synchronisation gap
   * and want different people; `engine-never-ran` is neither and wants nobody.
   */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'int', default: 0 })
  readings: number;

  @Column({ type: 'int', default: 0 })
  predictions: number;

  /** Jobs raised by this window, and alerts fired. */
  @Column({ name: 'jobs_raised', type: 'int', default: 0 })
  jobsRaised: number;

  @Column({ name: 'alerts_fired', type: 'int', default: 0 })
  alertsFired: number;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @CreateDateColumn({ name: 'ran_at', type: 'timestamptz' })
  ranAt: Date;
}
