import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { Confidence, SignalVerdict } from '../services/tier1';

export type PredictionSource = 'live' | 'replayed';

/**
 * One scored outcome for one scenario on one asset at one moment (task P1-12).
 *
 * Range-partitioned by month on `occurred_at`. Partitioning from the first migration
 * rather than when it hurts: converting a populated prediction table to a partitioned
 * one means copying every row under an exclusive lock, and the table only gets
 * converted once it is already too big to lock.
 *
 * `occurred_at` is the source timestamp of the newest reading the score was built
 * from — the logger's clock, not the server's. A replay of the same telemetry must
 * produce the same key, or replaying a month of history would write a month of
 * duplicate predictions dated today.
 */
@Entity('prediction')
@Index('uq_prediction_idempotent', ['tenantId', 'sourceSystem', 'externalId', 'clientScenarioSlug', 'occurredAt'], { unique: true })
export class Prediction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Part of the primary key because Postgres requires the partition key in every
   * unique constraint on a partitioned table. The requirement and the correct
   * idempotency key happen to coincide here, which is a good sign for both.
   */
  @PrimaryColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'client_scenario_slug', type: 'text' })
  clientScenarioSlug: string;

  @Column({ type: 'text' })
  severity: Severity;

  @Column({ name: 'risk_score', type: 'double precision' })
  riskScore: number;

  @Column({ name: 'abnormal_count', type: 'int' })
  abnormalCount: number;

  @Column({ name: 'high_priority', type: 'boolean', default: false })
  highPriority: boolean;

  /** Full, partial or none — see the note on Confidence. Never inferred from severity. */
  @Column({ type: 'text' })
  confidence: Confidence;

  /** Per-signal verdicts, kept so a prediction can be explained without recomputing it. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  signals: SignalVerdict[];

  @Column({ name: 'window_days', type: 'int' })
  windowDays: number;

  /**
   * Which scorer produced this. A bare tier number would not survive the model
   * registry (P1-16): two Tier 2 models disagreeing about the same asset is a
   * question someone will ask, and it is unanswerable without this.
   */
  @Column({ name: 'model_ref', type: 'text', default: 'tier1@1' })
  modelRef: string;

  @Column({ name: 'model_tier', type: 'int', default: 1 })
  modelTier: number;

  @Column({ type: 'text', default: 'live' })
  source: PredictionSource;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;
}
