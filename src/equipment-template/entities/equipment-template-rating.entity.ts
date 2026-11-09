import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One rated figure on a library model (D57). The unit is the rating's own, fixed in
 * `rating_parameter`, so it is not stored here to disagree with it.
 */
@Entity('equipment_template_rating')
export class EquipmentTemplateRating {
  @PrimaryColumn({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @PrimaryColumn({ type: 'text' })
  name: string;

  @Column({ type: 'double precision' })
  value: number;

  /** The datasheet or catalogue page the figure came from. Required. */
  @Column({ type: 'text' })
  source: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
