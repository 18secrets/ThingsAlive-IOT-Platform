import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One rated figure on an account's own model (D57); copied from the library, then theirs. */
@Entity('client_equipment_template_rating')
export class ClientEquipmentTemplateRating {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @PrimaryColumn({ type: 'text' })
  name: string;

  @Column({ type: 'double precision' })
  value: number;

  @Column({ type: 'text' })
  source: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
