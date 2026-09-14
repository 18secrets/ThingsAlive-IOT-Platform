import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ReadingSource = 'live' | 'replayed' | 'simulated';

/**
 * One sensor reading, keyed so that duplicates cannot double-count (task P1-44).
 *
 * The unique key is (imei, signal, source_timestamp). Reconnects, replays and
 * at-least-once delivery all produce duplicates; a duplicate silently corrupts a
 * rolling baseline, and a corrupted baseline silently corrupts every z-score built
 * on it. That failure is invisible until someone asks why a healthy machine is
 * flagged, which is why the constraint is in the schema rather than in a service.
 */
@Entity('telemetry_reading')
@Index('uq_telemetry_reading_dedupe', ['imei', 'signal', 'sourceTimestamp'], { unique: true })
@Index('ix_telemetry_reading_lookup', ['tenantId', 'imei', 'signal', 'sourceTimestamp'])
export class TelemetryReading {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  imei: string;

  /** Canonical signal name, resolved through the sensor map projection. */
  @Column({ type: 'text' })
  signal: string;

  @Column({ type: 'double precision' })
  value: number;

  @Column({ type: 'text', nullable: true })
  unit: string | null;

  /**
   * Two clocks, both UTC (task P1-46).
   *
   * source_timestamp is what the logger said; received_at is when the platform saw
   * it. Field loggers drift and reconnect with backlogs, so these diverge routinely.
   * Anything time-ordered must state which one it means — a prediction keyed to the
   * wrong clock is wrong in a way that looks like a model problem.
   */
  @Column({ name: 'source_timestamp', type: 'timestamptz' })
  sourceTimestamp: Date;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  /** Live telemetry, a replayed log or an injected fault — indistinguishable downstream. */
  @Column({ type: 'text', default: 'live' })
  source: ReadingSource;
}
