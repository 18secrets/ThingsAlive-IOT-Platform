import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * What one machine did with one shift (task P4-05).
 *
 * One row per shift window, replaced rather than appended when the window is scored
 * again. That is the opposite of what a prediction does, and the difference is
 * deliberate: a prediction is an opinion formed at a moment and its history is part of
 * the record, while this is a measurement of a fixed interval. When late telemetry
 * rewinds a window, the earlier row was not a different opinion — it was the same
 * measurement taken with a third of the evidence, and keeping both would put two
 * contradictory answers about Tuesday's hours in front of whoever adds them up.
 *
 * `plant_id` and `equipment_class_slug` are copied in rather than joined at read time.
 * Machines move between sites — that is what the placement log is for — and a join
 * would retroactively move last quarter's hours to wherever the machine is standing
 * today, which is exactly the number a site manager would notice and could not
 * explain.
 */
@Entity('utilization_shift')
/*
 * The asset is in the key as well as the shift.
 *
 * A shift belongs to one machine, so on today's schema the two are equivalent and the
 * asset columns are redundant. They are there because the failure mode of leaving
 * them out is silent: if a shift id ever reaches two machines — a seeding mistake, a
 * reassignment, a future schedule shared across a fleet — the narrower key would not
 * reject the second row, it would overwrite the first, and one machine's hours would
 * simply become another's with nothing logged and nothing to notice.
 */
@Index('uq_utilization_shift_window', ['tenantId', 'sourceSystem', 'externalId', 'shiftId', 'windowStart'], { unique: true })
@Index('ix_utilization_shift_asset', ['tenantId', 'sourceSystem', 'externalId', 'windowStart'])
@Index('ix_utilization_shift_plant', ['tenantId', 'plantId', 'windowStart'])
export class UtilizationShift {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'shift_id', type: 'uuid' })
  shiftId: string;

  @Column({ name: 'shift_name', type: 'text' })
  shiftName: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** Where the machine stood when the shift was worked, not where it stands now. */
  @Column({ name: 'plant_id', type: 'uuid', nullable: true })
  plantId: string | null;

  @Column({ name: 'equipment_class_slug', type: 'text', nullable: true })
  equipmentClassSlug: string | null;

  /** The day the plant calls it. */
  @Column({ name: 'local_date', type: 'text' })
  localDate: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd: Date;

  @Column({ name: 'total_seconds', type: 'double precision' })
  totalSeconds: number;

  @Column({ name: 'productive_seconds', type: 'double precision' })
  productiveSeconds: number;

  @Column({ name: 'idle_seconds', type: 'double precision' })
  idleSeconds: number;

  /**
   * Engine demonstrably on, with nothing reporting whether it was working.
   *
   * Kept as its own column rather than folded into idle, because the two want
   * different people: idle hours are a fuel bill, and unclassified hours are a
   * commissioning gap on the logger.
   */
  @Column({ name: 'running_unclassified_seconds', type: 'double precision' })
  runningUnclassifiedSeconds: number;

  @Column({ name: 'off_seconds', type: 'double precision' })
  offSeconds: number;

  /** Time nothing was entitled to describe. The column that keeps the rest honest. */
  @Column({ name: 'unknown_seconds', type: 'double precision' })
  unknownSeconds: number;

  @Column({ name: 'engine_on_seconds', type: 'double precision' })
  engineOnSeconds: number;

  @Column({ name: 'carry_seconds', type: 'double precision' })
  carrySeconds: number;

  /** Observed fraction of the window, 0..1. Every rate below is computed over it. */
  @Column({ type: 'double precision' })
  coverage: number;

  @Column({ name: 'utilization_rate', type: 'double precision', nullable: true })
  utilizationRate: number | null;

  @Column({ name: 'productive_rate', type: 'double precision', nullable: true })
  productiveRate: number | null;

  @Column({ name: 'idle_rate', type: 'double precision', nullable: true })
  idleRate: number | null;

  /** The hour meter's own delta, in whatever unit the logger reported. Unconverted. */
  @Column({ name: 'runtime_delta', type: 'double precision', nullable: true })
  runtimeDelta: number | null;

  @Column({ name: 'runtime_unit', type: 'text', nullable: true })
  runtimeUnit: string | null;

  @Column({ name: 'runtime_counter_reset', type: 'boolean', default: false })
  runtimeCounterReset: boolean;

  @Column({ type: 'int', default: 0 })
  samples: number;

  @Column({ name: 'signals_present', type: 'text', array: true, default: () => `'{}'::text[]` })
  signalsPresent: string[];

  @UpdateDateColumn({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;
}
