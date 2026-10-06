import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { numericHours, RecommendationUrgency } from '../../catalog/entities/equipment-class-recommendation.entity';

/**
 * A client's own copy of a class recommendation (task QREC0a). Points at the
 * client's own failure mode copy, by code, with the same foreign key guarantee the
 * platform row has.
 */
@Entity('client_equipment_class_recommendation')
@Index('ix_client_recommendation_class', ['tenantId', 'clientEquipmentClassSlug'])
export class ClientEquipmentClassRecommendation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ name: 'failure_mode_code', type: 'text' })
  failureModeCode: string;

  @Column({ type: 'text' })
  action: string;

  @Column({ type: 'text' })
  urgency: RecommendationUrgency;

  @Column({ name: 'estimated_hours', type: 'numeric', nullable: true, transformer: numericHours })
  estimatedHours: number | null;

  @Column({ name: 'required_parts', type: 'jsonb', nullable: true })
  requiredParts: unknown[] | null;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
