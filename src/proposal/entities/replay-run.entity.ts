import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ReplayOutcome } from '../proposal-kinds';

/** One machine's historical replay for one proposal (task QGEN1, D28). Immutable once written. */
@Entity('replay_run')
export class ReplayRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'proposal_id', type: 'uuid' })
  proposalId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'window_from', type: 'timestamptz' })
  windowFrom: Date;

  @Column({ name: 'window_to', type: 'timestamptz' })
  windowTo: Date;

  @Column({ name: 'compiler_version', type: 'text' })
  compilerVersion: string;

  /** Per signal: readings, days covered, first and last reading. */
  @Column({ type: 'jsonb' })
  signals: Record<string, unknown>[];

  @Column({ name: 'windows_evaluated', type: 'int' })
  windowsEvaluated: number;

  @Column({ type: 'int' })
  fires: number;

  @Column({ name: 'fires_detail', type: 'jsonb' })
  firesDetail: Record<string, unknown>;

  @Column({ type: 'text' })
  outcome: ReplayOutcome;

  @Column({ name: 'outcome_reason', type: 'text' })
  outcomeReason: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz' })
  finishedAt: Date;
}
