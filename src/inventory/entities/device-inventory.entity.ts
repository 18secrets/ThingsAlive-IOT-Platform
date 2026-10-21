import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type InventoryState = 'in-stock' | 'assigned' | 'retired';

/**
 * A physical logger, before it belongs to anybody (task P1-19).
 *
 * This table exists because the projection layer cannot hold one. A device in a
 * warehouse has no upstream client, and the sync refuses a record whose client does
 * not resolve to a tenant — correctly, because an untenanted projection row is a row
 * every tenant can read. So the stock a customer is about to be given is, from the
 * mirror's point of view, a stream of rejections.
 *
 * `tenant_id` is nullable, and that nullability is the isolation mechanism rather
 * than a convenience. The policy on this table compares `tenant_id` to the session's
 * tenant, and in SQL a null is never equal to anything — so an unassigned device is
 * invisible to every tenant without a second rule to maintain. Anyone tempted to add
 * `OR tenant_id IS NULL` to make the pool readable is removing the protection.
 *
 * Identity is the IMEI alone, not (source_system, external_id) as everywhere else in
 * 2.0. An IMEI is globally unique by construction, and stock does not come from a
 * source system — it comes from a purchase order. Two rows for one IMEI would mean
 * one physical device assigned to two customers.
 */
@Entity('device_inventory')
@Index('uq_device_inventory_imei', ['imei'], { unique: true })
@Index('ix_device_inventory_tenant', ['tenantId', 'state'])
@Index('ix_device_inventory_state', ['state'])
export class DeviceInventory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  imei: string;

  /**
   * Null until assigned, and the only way it stops being null is an assignment. No
   * service writes this column directly; see InventoryService.
   */
  @Column({ name: 'tenant_id', type: 'text', nullable: true })
  tenantId: string | null;

  @Column({ type: 'text', default: 'in-stock' })
  state: InventoryState;

  @Column({ type: 'text', nullable: true })
  model: string | null;

  /** The device profile this was registered against — nullable, same as `model`. */
  @Column({ name: 'tool_mapping_id', type: 'uuid', nullable: true })
  toolMappingId: string | null;

  /**
   * The delivery this device arrived in. Kept because hardware faults are
   * overwhelmingly correlated by batch — the question "what else came in that box"
   * is the first one asked when three loggers fail the same way in a fortnight.
   */
  @Column({ name: 'batch_ref', type: 'text', nullable: true })
  batchRef: string | null;

  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  @Column({ name: 'assigned_by', type: 'text', nullable: true })
  assignedBy: string | null;

  /**
   * Which asset the device is fitted to, set by the customer rather than by Things
   * Alive. Assignment is a commercial act and claiming is a physical one; a device
   * can sit in a customer's account for a month before anybody bolts it to a machine.
   */
  @Column({ name: 'equipment_external_id', type: 'text', nullable: true })
  equipmentExternalId: string | null;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ name: 'claimed_by', type: 'text', nullable: true })
  claimedBy: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
