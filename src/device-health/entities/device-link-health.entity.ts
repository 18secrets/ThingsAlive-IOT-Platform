import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { LinkState } from '../services/link-health';
import { SignalBand, SignalScale } from '../services/signal-scale';

/**
 * How one logger's link behaved over one shift window (task P4-08).
 *
 * Keyed on the device rather than the machine, because that is what the fault belongs
 * to: a logger moved to another machine takes its weak antenna with it, and a machine
 * carrying two loggers can have one healthy and one dark. The equipment reference is
 * copied alongside so a report can be read by site without a join, and for the same
 * reason it is copied on the utilization row — machines move, and last month's outage
 * happened where the machine was standing then.
 *
 * Upserted on the window, like duty cycle and for the same reason: this is a
 * measurement of a fixed interval, and when late telemetry rewinds a window the second
 * reading of it replaces the first rather than contradicting it.
 */
@Entity('device_link_health')
@Index('uq_device_link_health_window', ['tenantId', 'imei', 'windowStart'], { unique: true })
@Index('ix_device_link_health_asset', ['tenantId', 'externalId', 'windowStart'])
@Index('ix_device_link_health_state', ['tenantId', 'state', 'windowStart'])
export class DeviceLinkHealth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  imei: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  /** The machine the logger was fitted to when this window was worked. */
  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'plant_id', type: 'uuid', nullable: true })
  plantId: string | null;

  @Column({ name: 'local_date', type: 'text' })
  localDate: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd: Date;

  /** The diagnosis. Indexed, because "show me everything dark" is the whole screen. */
  @Column({ type: 'text' })
  state: LinkState;

  /** What was observed, in one line, so a screen can explain itself without recomputing. */
  @Column({ type: 'text' })
  detail: string;

  /**
   * The scale the signal was reported on, inferred rather than configured, and null
   * when the values could not say. Stored so a later correction is visible as a change
   * rather than silently rewriting history's meaning.
   */
  @Column({ name: 'signal_scale', type: 'text', nullable: true })
  signalScale: SignalScale | null;

  @Column({ name: 'signal_median', type: 'double precision', nullable: true })
  signalMedian: number | null;

  /** The worst moment. A link is judged by those, not by its median. */
  @Column({ name: 'signal_worst', type: 'double precision', nullable: true })
  signalWorst: number | null;

  @Column({ name: 'signal_band', type: 'text', nullable: true })
  signalBand: SignalBand | null;

  @Column({ name: 'signal_worst_band', type: 'text', nullable: true })
  signalWorstBand: SignalBand | null;

  /** Longest stretch of the window with nothing at all, ends included. */
  @Column({ name: 'longest_gap_seconds', type: 'double precision', nullable: true })
  longestGapSeconds: number | null;

  /** Seconds between a reading being taken and reaching the existing platform. */
  @Column({ name: 'median_lag_seconds', type: 'double precision', nullable: true })
  medianLagSeconds: number | null;

  @Column({ name: 'max_lag_seconds', type: 'double precision', nullable: true })
  maxLagSeconds: number | null;

  @Column({ name: 'reported_signals', type: 'text', array: true, default: () => `'{}'::text[]` })
  reportedSignals: string[];

  /** Mapped for this device and absent from the window: dead sensors, not a bad link. */
  @Column({ name: 'missing_signals', type: 'text', array: true, default: () => `'{}'::text[]` })
  missingSignals: string[];

  @Column({ type: 'int', default: 0 })
  samples: number;

  @UpdateDateColumn({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;
}
