import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Which role a catalogued sensor can fill (`1757970000000-LibraryStructure.ts`,
 * task QL1) — what answers "which catalogued sensor could satisfy this unmet
 * requirement". QL1 deliberately created no entity for this table; QIMP3 is the
 * first writer.
 *
 * Platform-owned, and not versioned with any class: a sensor's capabilities are a
 * property of the sensor, independent of which classes end up needing that role.
 */
@Entity('sensor_role_capability')
export class SensorRoleCapability {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sensor_id', type: 'uuid' })
  sensorId: string;

  @Column({ name: 'measurement_role', type: 'text' })
  measurementRole: string;

  @Column({ name: 'parameter_key', type: 'text', nullable: true })
  parameterKey: string | null;

  @Column({ name: 'canonical_unit', type: 'text', nullable: true })
  canonicalUnit: string | null;

  /** `'manual'` unless written by an import; see `1757990000000-CatalogImportProvenance.ts`. */
  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;
}
