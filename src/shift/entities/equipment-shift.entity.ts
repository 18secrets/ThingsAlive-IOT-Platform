import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Weekday } from '../services/shift-window';

export type ShiftStatus = 'active' | 'retired';

/**
 * When a machine is worked, as the client's super admin defines it (task P1-109).
 *
 * The reason this table exists is a decision about the product rather than about
 * scheduling: a prediction is not worth making per reading. A shift's worth of
 * telemetry is the unit that says something — a machine warm, loaded and running for
 * eight hours — and scoring every arriving record produces a hundred near-identical
 * answers an hour and no more information than one.
 *
 * That turns "when is there something new to say about this machine" from a question
 * about message arrival into a question about the plant's working day, which the
 * customer already knows the answer to and nobody else does. So the client's CEO or
 * manager assigns it, alongside the equipment master they already own.
 *
 * Hours are wall-clock in `timeZone` and never an offset. A plant on daylight saving
 * would otherwise be an hour wrong for half the year, in a way that shows up as
 * predictions drifting rather than as anything failing.
 */
@Entity('equipment_shift')
@Index('ix_equipment_shift_asset', ['tenantId', 'sourceSystem', 'externalId'])
@Index('uq_equipment_shift_name', ['tenantId', 'sourceSystem', 'externalId', 'name'], { unique: true })
export class EquipmentShift {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** What the plant calls it: "A", "Night", "General". */
  @Column({ type: 'text' })
  name: string;

  /** Minutes from local midnight, 0..1439. */
  @Column({ name: 'start_minute', type: 'int' })
  startMinute: number;

  /**
   * Minutes from local midnight, 1..1440.
   *
   * At or below `startMinute` means the shift runs past midnight. 1440 is the far end
   * of the day and is deliberately distinct from 0, which would describe a shift of no
   * length that runs overnight.
   */
  @Column({ name: 'end_minute', type: 'int' })
  endMinute: number;

  /**
   * The days it starts on, 0 for Sunday.
   *
   * A shift belongs to the day it begins, so a Friday night shift running into
   * Saturday is a Friday shift. Any other convention makes "did Friday night run"
   * unanswerable without also knowing the hours.
   */
  @Column({ type: 'int', array: true })
  days: Weekday[];

  /** IANA name. Validated on write, because an unresolvable zone computes a window
   * that is silently wrong rather than one that fails. */
  @Column({ name: 'time_zone', type: 'text' })
  timeZone: string;

  @Column({ type: 'text', default: 'active' })
  status: ShiftStatus;

  /**
   * The end of the last shift this machine has been scored for.
   *
   * The watermark the runner reads: everything that ended after this and before now is
   * owed. Null means nothing has run yet, which is why the first run scores the most
   * recent shift rather than every shift since the machine was commissioned.
   */
  @Column({ name: 'scored_through', type: 'timestamptz', nullable: true })
  scoredThrough: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
