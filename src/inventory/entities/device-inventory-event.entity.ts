import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { InventoryAction } from '../services/inventory-state-machine';
import { InventoryState } from './device-inventory.entity';

/**
 * Every movement of a device, kept for longer than the device is in any one account
 * (task P1-19).
 *
 * The tenant on the row is the account the movement concerned — the one gaining the
 * device, or the one losing it — and the isolation policy uses it, so a customer can
 * read the history of their own devices and nothing else. Movements while a logger
 * was in stock carry no tenant, and a null is never equal to anything, so those are
 * invisible from inside an account without a second rule.
 *
 * Things Alive reads the whole chain through the audited platform path. That is the
 * view worth having: where has this logger been, how many times has it come back,
 * did the batch it arrived in fail everywhere or only here. None of those questions
 * can be answered from inside one account, and none of them are a customer's to ask.
 */
@Entity('device_inventory_event')
@Index('ix_device_inventory_event_imei', ['imei', 'at'])
@Index('ix_device_inventory_event_tenant', ['tenantId', 'at'])
export class DeviceInventoryEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  imei: string;

  @Column({ type: 'text' })
  action: InventoryAction;

  @Column({ name: 'from_state', type: 'text', nullable: true })
  fromState: InventoryState | null;

  @Column({ name: 'to_state', type: 'text' })
  toState: InventoryState;

  /** The tenant this movement concerned — the one gaining it, or the one losing it. */
  @Column({ name: 'tenant_id', type: 'text', nullable: true })
  tenantId: string | null;

  @Column({ name: 'equipment_external_id', type: 'text', nullable: true })
  equipmentExternalId: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'actor_user_id', type: 'text' })
  actorUserId: string;

  @Column({ name: 'actor_roles', type: 'text', array: true, default: () => `'{}'::text[]` })
  actorRoles: string[];

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
