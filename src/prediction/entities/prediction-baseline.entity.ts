import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Where the readings behind a baseline came from. Mixed is normal during a backfill. */
export type BaselineSource = 'live' | 'replayed' | 'mixed';

/**
 * What normal looks like for one signal on one asset (task P1-13).
 *
 * Derived and rebuildable: delete every row here and the next refresh restores them
 * from telemetry. That is deliberate — a baseline is a cache of an answer, and the
 * moment it becomes the only copy of something, a bad window becomes permanent.
 *
 * Keyed on the window length as well as the signal, because a seven-day and a
 * thirty-day baseline for the same signal are different facts and a scenario chooses
 * which it wants. Storing one and calling it "the" baseline would force every
 * scenario to share a window, which suits none of them.
 *
 * Tenant-owned, and therefore covered by row-level security.
 */
@Entity('prediction_baseline')
@Index('uq_prediction_baseline', ['tenantId', 'sourceSystem', 'externalId', 'signal', 'windowDays'], { unique: true })
@Index('ix_prediction_baseline_asset', ['tenantId', 'sourceSystem', 'externalId'])
export class PredictionBaseline {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** Canonical signal name. Telemetry is canonicalised at ingest, so no aliasing here. */
  @Column({ type: 'text' })
  signal: string;

  @Column({ name: 'window_days', type: 'int' })
  windowDays: number;

  @Column({ type: 'double precision' })
  mean: number;

  /**
   * Sample standard deviation, not population. The window is a sample of the machine's
   * behaviour rather than the whole of it, and with small windows the difference is
   * large enough to move a z-score across a band.
   */
  @Column({ type: 'double precision' })
  stddev: number;

  @Column({ name: 'sample_count', type: 'int' })
  sampleCount: number;

  /**
   * The fraction of days in the window that contain any reading at all.
   *
   * A thirty-day baseline built from two busy days is not a thirty-day baseline, and
   * sample count alone cannot tell the difference — a logger reporting every second
   * for one afternoon produces tens of thousands of samples covering nothing.
   */
  @Column({ name: 'coverage_ratio', type: 'double precision' })
  coverageRatio: number;

  @Column({ name: 'first_sample_at', type: 'timestamptz' })
  firstSampleAt: Date;

  @Column({ name: 'last_sample_at', type: 'timestamptz' })
  lastSampleAt: Date;

  /**
   * A baseline built from replayed history is a different kind of evidence from one
   * built from live telemetry — same arithmetic, different provenance — and anyone
   * reading a surprising prediction asks this question within the first minute.
   */
  @Column({ type: 'text', default: 'live' })
  source: BaselineSource;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;
}
