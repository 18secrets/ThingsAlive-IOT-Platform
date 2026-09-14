import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Rows the sync refused, kept rather than dropped (task P1-50).
 *
 * The common case is a record whose client has no entry in tenant_map. The wrong
 * response is to default the tenant — an untenanted row is a row every tenant can
 * read. The right response is to refuse it, keep it where somebody can see it, and
 * let the count be the alarm.
 */
@Entity('projection_rejection')
@Index('ix_projection_rejection_kind', ['kind', 'createdAt'])
export class ProjectionRejection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  /** equipment | device | sensor_map | telemetry */
  @Column({ type: 'text' })
  kind: string;

  @Column({ name: 'external_id', type: 'text', nullable: true })
  externalId: string | null;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
