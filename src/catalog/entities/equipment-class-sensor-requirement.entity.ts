import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type SensorRequirementCriticality = 'required' | 'recommended' | 'optional';

/**
 * What a class of machine needs, per role (`1757970000000-LibraryStructure.ts`,
 * task QL1). QL1 deliberately created no entity for this table; QIMP3 is the first
 * writer.
 *
 * Platform-owned, versioned with the class it belongs to via (class_slug,
 * class_version) — a published version is immutable, so a change here always targets
 * a draft, new or existing.
 */
@Entity('equipment_class_sensor_requirement')
export class EquipmentClassSensorRequirement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ name: 'measurement_role', type: 'text' })
  measurementRole: string;

  @Column({ name: 'component_scope', type: 'text', default: '' })
  componentScope: string;

  @Column({ type: 'text', default: 'required' })
  criticality: SensorRequirementCriticality;

  @Column({ name: 'min_count', type: 'int', default: 1 })
  minCount: number;

  @Column({ name: 'canonical_unit', type: 'text', nullable: true })
  canonicalUnit: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  enables: string[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** `'manual'` unless written by an import; see `1757990000000-CatalogImportProvenance.ts`. */
  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;
}
