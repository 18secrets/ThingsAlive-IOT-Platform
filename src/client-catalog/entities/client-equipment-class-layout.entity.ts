import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { WidgetSize, WidgetType } from '../../catalog/layout/widget-types';

/**
 * A tenant's own copy of a class's page layout (task QREC0b).
 *
 * The tenant gets two changes and no more: hide a widget, and reorder. Adding a widget
 * belongs with QPAGE1, where there is something to render it. `positionCustom` is what
 * lets a new class version respect a reorder rather than silently reverting it — see
 * `mergeTenantLayout` in layout-rules.ts.
 */
@Entity('client_equipment_class_layout')
export class ClientEquipmentClassLayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ name: 'widget_type', type: 'text' })
  widgetType: WidgetType;

  @Column({ name: 'widget_key', type: 'text' })
  widgetKey: string;

  @Column({ name: 'bound_to', type: 'text', nullable: true })
  boundTo: string | null;

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'text' })
  size: WidgetSize;

  @Column({ type: 'boolean', default: false })
  hidden: boolean;

  @Column({ name: 'position_custom', type: 'boolean', default: false })
  positionCustom: boolean;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
