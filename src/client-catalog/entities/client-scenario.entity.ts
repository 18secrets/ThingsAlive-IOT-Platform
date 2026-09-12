import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { ScenarioParameter, ScenarioTier } from '../../catalog/entities/scenario-definition.entity';
import { ClientCatalogStatus } from './client-equipment-class.entity';

/**
 * A client's own copy of a scenario definition (see ClientEquipmentClass).
 *
 * Owned outright by the client's super admin: thresholds, required signals, severity
 * and failure descriptions are all theirs to change. There is no bounds check against
 * the template, because under this model the template stopped being authoritative the
 * moment the copy was made.
 *
 * That is a real trade and worth stating plainly. A client can set a coolant shutdown
 * above what the engine builder allows, and nothing here will stop them. What the
 * platform does instead is remember: `templateChecksum` makes an edited copy
 * distinguishable from an untouched one, and `enabled` lets a client switch a
 * scenario off without deleting the record of having had it.
 */
@Entity('client_scenario')
@Index('uq_client_scenario', ['tenantId', 'slug'], { unique: true })
@Index('ix_client_scenario_class', ['tenantId', 'clientEquipmentClassSlug'])
export class ClientScenario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  slug: string;

  /** References the client's own class by slug, not the template's. */
  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: Severity.Medium })
  severity: Severity;

  @Column({ type: 'int', default: 1 })
  tier: ScenarioTier;

  @Column({ name: 'required_signals', type: 'text', array: true, default: () => `'{}'::text[]` })
  requiredSignals: string[];

  @Column({ name: 'minimum_history_days', type: 'int', default: 0 })
  minimumHistoryDays: number;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  parameters: ScenarioParameter[];

  /**
   * Off without being gone. A deleted scenario loses the fact that this client once
   * ran it, which is the first thing anyone asks when an alert stops arriving.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'template_slug', type: 'text', nullable: true })
  templateSlug: string | null;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'template_checksum', type: 'text', nullable: true })
  templateChecksum: string | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @Column({ type: 'text', default: 'active' })
  status: ClientCatalogStatus;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
