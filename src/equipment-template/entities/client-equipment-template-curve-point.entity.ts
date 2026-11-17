import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One point of an account's own copy of a model's duty curve (D58). Units are in the column names, fixed by the curve kind. */
@Entity('client_equipment_template_curve_point')
export class ClientEquipmentTemplateCurvePoint {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @PrimaryColumn({ type: 'text', default: 'duty' })
  curve: 'duty';

  /** Order along the curve: rising flow, falling head. */
  @PrimaryColumn({ type: 'int' })
  point: number;

  @Column({ name: 'head_m', type: 'double precision' })
  headM: number;

  @Column({ name: 'flow_lpm', type: 'double precision' })
  flowLpm: number;

  @Column({ name: 'input_kw', type: 'double precision' })
  inputKw: number;

  @Column({ type: 'text' })
  source: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
