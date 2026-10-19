import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The tables of task QML1. Why each exists, and what the database holds of it, is in
 * `1761100000000-Forecasting.ts`. */

export type ForecastModelStatus = 'active' | 'retired';

@Entity('forecast_model')
export class ForecastModel {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) key: string;
  @Column({ type: 'text' }) revision: string;
  @Column({ type: 'text' }) runtime: 'pytorch-cpu';
  @Column({ name: 'context_length', type: 'int' }) contextLength: number;
  @Column({ name: 'prediction_length', type: 'int' }) predictionLength: number;
  @Column({ name: 'weights_sha256', type: 'text' }) weightsSha256: string;
  @Column({ type: 'text' }) license: string;
  @Column({ type: 'text' }) status: ForecastModelStatus;
  @Column({ name: 'approved_by', type: 'text' }) approvedBy: string;
  @Column({ name: 'approved_at', type: 'timestamptz' }) approvedAt: Date;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export type ForecastRunOutcome = 'running' | 'completed' | 'budget_exhausted' | 'failed' | 'lock_held';

@Entity('forecast_run')
export class ForecastRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'started_at', type: 'timestamptz' }) startedAt: Date;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
  @Column({ name: 'budget_seconds', type: 'int' }) budgetSeconds: number;
  @Column({ name: 'model_id', type: 'uuid', nullable: true }) modelId: string | null;
  @Column({ type: 'text' }) outcome: ForecastRunOutcome;
  @Column({ type: 'int', default: 0 }) considered: number;
  @Column({ type: 'int', default: 0 }) forecast: number;
  @Column({ type: 'int', default: 0 }) skipped: number;
  @Column({ type: 'int', default: 0 }) refused: number;
  @Column({ name: 'python_load_seconds', type: 'double precision', nullable: true }) pythonLoadSeconds: number | null;
  @Column({ name: 'python_infer_seconds', type: 'double precision', nullable: true }) pythonInferSeconds: number | null;
  @Column({ type: 'text', nullable: true }) error: string | null;
}

export type SkipReason =
  | 'stale' | 'no_readings' | 'unbound' | 'insufficient_coverage' | 'gap_at_edge' | 'budget_exhausted' | 'refused';

@Entity('forecast_run_skip')
export class ForecastRunSkip {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'run_id', type: 'uuid' }) runId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  @Column({ type: 'text' }) signal: string;
  @Column({ type: 'text' }) reason: SkipReason;
  @Column({ type: 'text', nullable: true }) detail: string | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

@Entity('forecast_input_bucket')
export class ForecastInputBucket {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  @Column({ type: 'text' }) signal: string;
  @Column({ name: 'bucket_at', type: 'timestamptz' }) bucketAt: Date;
  @Column({ type: 'double precision' }) value: number;
  @Column({ type: 'int' }) readings: number;
}

/** One forecast point on screen: when, the prediction, and its interval (D26). */
export interface HorizonPoint {
  t: string;
  v: number;
  lo: number | null;
  hi: number | null;
}

@Entity('forecast_latest')
export class ForecastLatest {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  @Column({ type: 'text' }) signal: string;
  @Column({ name: 'model_id', type: 'uuid' }) modelId: string;
  @Column({ name: 'run_id', type: 'uuid' }) runId: string;
  @Column({ name: 'generated_at', type: 'timestamptz' }) generatedAt: Date;
  @Column({ name: 'step_seconds', type: 'int' }) stepSeconds: number;
  @Column({ name: 'context_from', type: 'timestamptz' }) contextFrom: Date;
  @Column({ name: 'context_to', type: 'timestamptz' }) contextTo: Date;
  @Column({ name: 'input_coverage', type: 'double precision' }) inputCoverage: number;
  @Column({ name: 'imputed_steps', type: 'int' }) imputedSteps: number;
  @Column({ type: 'jsonb' }) horizon: HorizonPoint[];
}

@Entity('forecast_residual')
export class ForecastResidual {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  @Column({ type: 'text' }) signal: string;
  @Column({ name: 'model_id', type: 'uuid' }) modelId: string;
  @Column({ name: 'run_id', type: 'uuid' }) runId: string;
  @Column({ name: 'step_at', type: 'timestamptz' }) stepAt: Date;
  @Column({ name: 'lead_steps', type: 'int' }) leadSteps: number;
  @Column({ type: 'double precision' }) predicted: number;
  @Column({ type: 'double precision' }) actual: number;
  @Column({ type: 'double precision' }) residual: number;
  /** Null when the machine has no shift schedule to tell operating from parked. */
  @Column({ type: 'boolean', nullable: true }) operating: boolean | null;
}

@Entity('forecast_daily_sample')
export class ForecastDailySample {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  @Column({ type: 'text' }) signal: string;
  @Column({ type: 'date' }) day: string;
  @Column({ name: 'model_id', type: 'uuid' }) modelId: string;
  @Column({ name: 'run_id', type: 'uuid' }) runId: string;
  @Column({ name: 'generated_at', type: 'timestamptz' }) generatedAt: Date;
  @Column({ name: 'step_seconds', type: 'int' }) stepSeconds: number;
  @Column({ type: 'jsonb' }) horizon: HorizonPoint[];
}

export const FORECAST_ENTITIES = [
  ForecastModel, ForecastRun, ForecastRunSkip, ForecastInputBucket, ForecastLatest, ForecastResidual, ForecastDailySample,
];
