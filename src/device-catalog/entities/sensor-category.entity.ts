import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * The coarse grouping a sensor is filed under — 'Engine', 'Hydraulics', 'Fuel'.
 *
 * Platform-owned, like `sensor` and `tool_mapping`: this is Master Admin's own
 * reference data for wiring devices, not anything a tenant reads or writes, so there
 * is no tenant column and no row-level security to enforce.
 *
 * No delete: a sensor may already reference a category by id, and removing the row
 * out from under it would leave a sensor pointing at nothing. Renaming and retiring
 * (task QCAT2) are the edits this table supports.
 */
@Entity('sensor_category')
export class SensorCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  @Index('uq_sensor_category_name', { unique: true })
  name: string;

  /**
   * Retired: no longer offered for new work, still resolving everywhere it is already
   * used (task QCAT2, `1758410000000-SensorRetirement.ts`). Null is live.
   */
  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt: Date | null;

  @Column({ name: 'retired_by', type: 'text', nullable: true })
  retiredBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
