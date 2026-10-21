import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SignalBindingOrigin = 'physical' | 'ecu_derived' | 'virtual';
export type SignalBindingStatus = 'proposed' | 'discovered_unreviewed' | 'active' | 'superseded' | 'rejected';
export type SignalBindingDiscoveredBy = 'tool-mapping' | 'sensor-map' | 'both' | 'manual' | 'model';

/**
 * What closes the gap between "a reading arrived" and "this equipment has this
 * signal" (`1757960000000-SignalBindings.ts`, task Q08S slice 1). Slice 1
 * deliberately created no entity for this table; this slice (coverage, discovery,
 * resolve-at-event-time) is the first reader and writer.
 *
 * `validity` is a Postgres-generated `tstzrange` column
 * (`tstzrange(valid_from, valid_to, '[)')`, STORED) — deliberately not mapped here.
 * TypeORM has no first-class range type, and the only thing this layer ever does
 * with it is a containment query (`validity @> :at`), which reads it as a raw
 * column reference rather than an entity property.
 *
 * Exactly one PRIMARY, active binding per (tenant, equipment, signal_key,
 * component_id) can be valid at a given instant — enforced by
 * `ex_signal_binding_primary`, a GiST exclusion constraint, not by this service:
 * a service check loses to a concurrent insert.
 */
@Entity('signal_binding_version')
@Index('ix_signal_binding_equipment', ['tenantId', 'sourceSystem', 'externalId', 'signalKey'])
@Index('ix_signal_binding_resolve', ['tenantId', 'imei', 'signalKey'])
export class SignalBindingVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  /** Canonical signal name — what the exclusion constraint keys on. */
  @Column({ name: 'signal_key', type: 'text' })
  signalKey: string;

  /** The class's expected-signal / sensor-requirement role this binding satisfies. */
  @Column({ name: 'measurement_role', type: 'text' })
  measurementRole: string;

  /** '' is the machine itself, never NULL — see the migration's own comment on why. */
  @Column({ name: 'component_id', type: 'text', default: '' })
  componentId: string;

  @Column({ type: 'text' })
  origin: SignalBindingOrigin;

  @Column({ type: 'text', nullable: true })
  imei: string | null;

  @Column({ type: 'text', nullable: true })
  channel: string | null;

  @Column({ name: 'sensor_instance_id', type: 'uuid', nullable: true })
  sensorInstanceId: string | null;

  @Column({ name: 'canonical_unit', type: 'text' })
  canonicalUnit: string;

  @Column({ name: 'source_unit', type: 'text', nullable: true })
  sourceUnit: string | null;

  @Column({ name: 'unit_transform_version', type: 'text', nullable: true })
  unitTransformVersion: string | null;

  @Column({ name: 'calibration_version_id', type: 'uuid', nullable: true })
  calibrationVersionId: string | null;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom: Date;

  /** Half-open: NULL means still open-ended. */
  @Column({ name: 'valid_to', type: 'timestamptz', nullable: true })
  validTo: Date | null;

  @Column({ name: 'expected_period_seconds', type: 'int', nullable: true })
  expectedPeriodSeconds: number | null;

  @Column({ name: 'freshness_policy', type: 'jsonb', default: () => `'{}'::jsonb` })
  freshnessPolicy: Record<string, unknown>;

  @Column({ name: 'quality_policy', type: 'jsonb', default: () => `'{}'::jsonb` })
  qualityPolicy: Record<string, unknown>;

  /** Whether this is THE binding for its (signal, component) — never more than one, at once. */
  @Column({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean;

  @Column({ type: 'text', default: 'proposed' })
  status: SignalBindingStatus;

  /** The sensor_map_projection row this was discovered from, if any. */
  @Column({ name: 'discovered_from', type: 'uuid', nullable: true })
  discoveredFrom: string | null;

  @Column({ name: 'discovered_by', type: 'text', default: 'manual' })
  discoveredBy: SignalBindingDiscoveredBy;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
