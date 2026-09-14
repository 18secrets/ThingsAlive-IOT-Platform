import { Column, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What every projection row carries, regardless of what it projects (task P1-41).
 *
 * A projection is a read-only mirror of data the existing platform owns. 2.0 never
 * writes back. The metadata below exists so that staleness is visible rather than
 * silent: a prediction scored against a four-hour-old sensor mapping is wrong in a
 * way that looks like a model problem.
 */
export abstract class ProjectionBase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Which upstream system this came from. Half of the external identity (P1-40). */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  /**
   * The upstream primary key. Never used alone: integer keys collide the moment
   * there is a second source or the old database is reseeded.
   */
  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** Resolved through tenant_map. A row that cannot resolve one is rejected, not defaulted. */
  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** The upstream record, verbatim, for fields 2.0 has no column for yet. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  /** When the source last changed the record, as reported by the source. */
  @Column({ name: 'source_updated_at', type: 'timestamptz', nullable: true })
  sourceUpdatedAt: Date | null;

  /** When 2.0 last wrote this row. The difference between the two is the staleness. */
  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;

  /** Content hash, so an unchanged record is not rewritten and reconcile is a diff. */
  @Column({ type: 'text' })
  checksum: string;

  /** live = present upstream; missing = absent from the last full reconcile. */
  @Column({ type: 'text', default: 'live' })
  @Index()
  status: 'live' | 'missing';
}
