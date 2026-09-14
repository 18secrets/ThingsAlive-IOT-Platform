import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CatalogStatus } from '../../catalog/entities/equipment-class-profile.entity';
import { ChainNode } from '../services/causal-chain';

/**
 * A physical chain of cause and effect, as catalog content (task P4-01).
 *
 * Platform-owned and versioned like a scenario definition, and for the same reason:
 * the coefficients in it are a claim about how a kind of machine behaves, a client's
 * alerts are configured against a version of that claim, and editing a published one
 * would move the ground under every alert already running on it. A change publishes a
 * new version.
 *
 * The nodes are jsonb rather than rows. A chain is read whole or not at all — every
 * stage needs the ones above it to mean anything — so there is no query that wants a
 * single stage, and normalising it would buy a join for no question anybody asks.
 *
 * What these are *not* is fitted. The coefficients come from physics and machine
 * specification, which is what lets a chain work on a fleet that started reporting
 * yesterday. Fitting them from telemetry later refines the numbers; the structure is
 * where the meaning lives and that comes from somebody who knows the machines.
 */
@Entity('causal_chain')
@Index('uq_causal_chain_version', ['slug', 'version'], { unique: true })
@Index('ix_causal_chain_class', ['equipmentClassSlug'])
@Index('ix_causal_chain_status', ['status'])
export class CausalChainDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  /** Referenced by slug, not by row id: a class version bump must not orphan this. */
  @Column({ name: 'equipment_class_slug', type: 'text' })
  equipmentClassSlug: string;

  /**
   * The scenario this chain is the intelligence for, when it is for one.
   *
   * Nullable because a chain can be diagnostic without predicting a named failure —
   * "is this machine behaving like itself" is worth answering on its own.
   */
  @Column({ name: 'scenario_slug', type: 'text', nullable: true })
  scenarioSlug: string | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** What the far end of the chain is watching for, in words. */
  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  /** The stages. Read whole; there is no question that wants one of them. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  nodes: ChainNode[];

  @Column({ name: 'alignment_seconds', type: 'int', nullable: true })
  alignmentSeconds: number | null;

  /**
   * Where the numbers came from, named.
   *
   * A coefficient with no provenance is a number somebody will not dare change in two
   * years' time, because nobody will remember whether it came from an OEM curve or a
   * guess in a meeting. The catalog research notes carry the same discipline.
   */
  @Column({ type: 'text', nullable: true })
  provenance: string | null;

  @Column({ type: 'text', default: 'draft' })
  status: CatalogStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
