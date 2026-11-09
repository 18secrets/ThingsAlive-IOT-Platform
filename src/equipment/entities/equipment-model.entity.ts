import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Which of the account's models a machine is (D57): where its rated figures, and its
 * pump's duty curve, come from when the machine has none of its own. Beside
 * `equipment_profile` rather than a column on it (D06's shape).
 */
@Entity('equipment_model')
export class EquipmentModel {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ name: 'equipment_id', type: 'uuid' })
  equipmentId: string;

  @Column({ name: 'client_equipment_template_id', type: 'uuid' })
  modelId: string;

  @Column({ name: 'assigned_by', type: 'text' })
  assignedBy: string;

  @Column({ name: 'assigned_at', type: 'timestamptz', default: () => 'now()' })
  assignedAt: Date;
}
