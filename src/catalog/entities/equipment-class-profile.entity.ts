import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type CatalogStatus = 'draft' | 'published' | 'retired';

/** One signal the class expects, named canonically. */
export interface ExpectedSignal {
  signal: string;
  unit: string | null;
  /** A scenario can only require a signal the class declares. */
  required: boolean;
  description?: string;
}

export interface FailureMode {
  code: string;
  name: string;
  /** What the operator would notice. Plain language, because it reaches a screen. */
  symptom: string;
  /** Signals that move when this happens — the link between domain and telemetry. */
  signals: string[];
}

/**
 * A class of machine, described once and reused by every tenant that owns one
 * (task P1-01).
 *
 * Platform-owned: no tenant column, no row-level security. What a tenant may see is
 * decided by `client_catalog_entitlement`, not by ownership of the row — a class
 * described for one customer is the same class for the next, and copying it per
 * tenant would mean an OEM threshold correction had to be applied in fifty places.
 *
 * Versioned and immutable once published, for the reason in ScenarioDefinition.
 */
@Entity('equipment_class_profile')
@Index('uq_equipment_class_profile_version', ['slug', 'version'], { unique: true })
export class EquipmentClassProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stable, human-readable, and what everything else references: 'diesel-generator'. */
  @Column({ type: 'text' })
  @Index('ix_equipment_class_profile_slug')
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Coarse grouping for the catalog UI —  'power', 'machining', 'fluid'. */
  @Column({ type: 'text', nullable: true })
  category: string | null;

  @Column({ name: 'expected_signals', type: 'jsonb', default: () => `'[]'::jsonb` })
  expectedSignals: ExpectedSignal[];

  /**
   * Written by someone who knows the machines (task P1-02), not inferred from data.
   * A failure mode nobody in the field recognises produces alerts nobody acts on.
   */
  @Column({ name: 'failure_modes', type: 'jsonb', default: () => `'[]'::jsonb` })
  failureModes: FailureMode[];

  /** OEM limits and sensible defaults, per signal. Tenants may narrow, never widen. */
  @Column({ name: 'default_thresholds', type: 'jsonb', default: () => `'{}'::jsonb` })
  defaultThresholds: Record<string, unknown>;

  @Column({ type: 'text', default: 'draft' })
  @Index('ix_equipment_class_profile_status')
  status: CatalogStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
