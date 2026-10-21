import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Which sensor is active on this tool profile, and which of its parameters.
 *
 * Only the id is stored. The name is resolved live from `sensor` on every read —
 * never snapshotted here — so renaming a sensor or narrowing its parameter list is
 * reflected everywhere it is mapped instead of drifting from a copy nobody remembers
 * to update.
 */
export interface MappedSensorRef {
  sensorId: string;
  parameters: string[];
}

/**
 * A device profile: the sensors Master Admin expects a device registered against
 * this tool to report, and which of each sensor's channels are active.
 *
 * Platform-owned, flat master data — same reasoning as `Sensor`. `DeviceInventory`
 * references a tool mapping by id (see the 1757930000000 migration) so a device's
 * expected telemetry is known the moment it is registered, before any client has
 * claimed it onto their own equipment.
 */
@Entity('tool_mapping')
export class ToolMapping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tool_name', type: 'text' })
  toolName: string;

  /** The industry this profile is for (task QINDUSTRY). */
  @Column({ name: 'industry_type_id', type: 'uuid', nullable: true })
  industryTypeId: string | null;

  /** What was typed before QINDUSTRY, kept and never written again (a trigger refuses
   * it): the text Master Admin re-matches once the real types exist. */
  @Column({ name: 'industry_type_legacy', type: 'text', nullable: true, update: false, insert: false })
  industryTypeLegacy: string | null;

  @Column({ type: 'text', nullable: true })
  protocol: string | null;

  @Column({ name: 'mapped_sensors', type: 'jsonb', default: () => `'[]'::jsonb` })
  mappedSensors: MappedSensorRef[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
