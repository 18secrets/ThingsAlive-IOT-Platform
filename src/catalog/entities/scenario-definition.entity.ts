import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { CatalogStatus } from './equipment-class-profile.entity';

/**
 * Which scoring tier a scenario needs, and therefore what it costs to run.
 * 1 = deterministic rules on windows, 2 = weak supervision, 3 = a trained model.
 */
export type ScenarioTier = 1 | 2 | 3;

/** A tunable a tenant may set within the bounds the catalog declares. */
export interface ScenarioParameter {
  key: string;
  label: string;
  type: 'number' | 'duration' | 'boolean' | 'enum';
  default: unknown;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
}

/**
 * One prediction scenario, defined by Things Alive and activated by tenants
 * (task P1-01).
 *
 * **Immutable once published.** A change publishes a new version rather than editing
 * the old one, and an activation pins the version it was activated against. Editing a
 * live definition would silently move the thresholds under every alert already
 * running on it — the resulting incident looks like a model regression, and the
 * evidence of what actually changed is gone, because it was overwritten.
 */
@Entity('scenario_definition')
@Index('uq_scenario_definition_version', ['slug', 'version'], { unique: true })
@Index('ix_scenario_definition_class', ['equipmentClassSlug'])
export class ScenarioDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  @Index('ix_scenario_definition_slug')
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  /** Referenced by slug, not by row id: a class version bump must not orphan this. */
  @Column({ name: 'equipment_class_slug', type: 'text' })
  equipmentClassSlug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The one severity vocabulary. Foreign values are mapped at the boundary. */
  @Column({ type: 'text', default: Severity.Medium })
  severity: Severity;

  @Column({ type: 'int', default: 1 })
  tier: ScenarioTier;

  /**
   * Canonical signal names. A scenario cannot run without every one of these, and the
   * recommendation engine reports exactly which are missing rather than saying no.
   */
  @Column({ name: 'required_signals', type: 'text', array: true, default: () => `'{}'::text[]` })
  requiredSignals: string[];

  /**
   * How much history the scenario needs before its output means anything. Declared,
   * not guessed: a z-score against four hours of baseline is a number, not a signal.
   */
  @Column({ name: 'minimum_history_days', type: 'int', default: 0 })
  minimumHistoryDays: number;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  parameters: ScenarioParameter[];

  @Column({ type: 'text', default: 'draft' })
  @Index('ix_scenario_definition_status')
  status: CatalogStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
