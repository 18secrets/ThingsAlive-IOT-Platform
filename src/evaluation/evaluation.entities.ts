import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The tables of task QEVAL1a. Why each exists, and what the database holds of it, is in
 * `1761300000000-Evaluation.ts`. */

export type EvalKind = 'ttm_backtest' | 'retrieval' | 'recommendation_replay';
export type EvalStatus = 'running' | 'completed' | 'budget_exhausted' | 'failed' | 'lock_held';
export type EvalDataset = 'seeded' | 'real';

@Entity('eval_run')
export class EvalRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) kind: EvalKind;
  @Column({ type: 'text' }) status: EvalStatus;
  @Column({ type: 'text' }) dataset: EvalDataset;
  @Column({ name: 'dataset_note', type: 'text', nullable: true }) datasetNote: string | null;
  @Column({ type: 'jsonb' }) versions: Record<string, unknown>;
  @Column({ name: 'window_from', type: 'timestamptz' }) windowFrom: Date;
  @Column({ name: 'window_to', type: 'timestamptz' }) windowTo: Date;
  @Column({ name: 'budget_seconds', type: 'int' }) budgetSeconds: number;
  @Column({ name: 'budget_series', type: 'int' }) budgetSeries: number;
  @Column({ name: 'started_at', type: 'timestamptz' }) startedAt: Date;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
  @Column({ type: 'int', default: 0 }) unreached: number;
  @Column({ type: 'jsonb', nullable: true }) summary: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) error: string | null;
}

@Entity('eval_result')
export class EvalResult {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'run_id', type: 'uuid' }) runId: string;
  @Column({ name: 'source_system', type: 'text' }) sourceSystem: string;
  @Column({ name: 'external_id', type: 'text' }) externalId: string;
  /** What was evaluated on that machine: a signal role for the backtest. */
  @Column({ type: 'text' }) subject: string;
  /** Which measurement: `daily_sample`, `replay`, `anomaly_states`, or `unreached`. */
  @Column({ type: 'text' }) variant: string;
  @Column({ type: 'jsonb' }) metrics: Record<string, unknown>;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export const EVALUATION_ENTITIES = [EvalRun, EvalResult];
