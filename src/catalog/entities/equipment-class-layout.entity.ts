import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WidgetSize, WidgetType } from '../layout/widget-types';

/**
 * One widget on a class's machine page (`1758200000000-PageLayout.ts`, task QREC0b).
 *
 * The type is from the closed vocabulary in code; the instance — which widget, where,
 * bound to what — is this row. Platform-owned, versioned with the class via
 * (class_slug, class_version), copied on grant. A class with none of these rows is
 * valid and gets the computed fallback in layout-rules.ts.
 */
@Entity('equipment_class_layout')
export class EquipmentClassLayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ name: 'widget_type', type: 'text' })
  widgetType: WidgetType;

  /** Stable within (class, version) — what a tenant's hide or reorder is keyed by. */
  @Column({ name: 'widget_key', type: 'text' })
  widgetKey: string;

  /** A formula_key or a declared signal; NULL for a type that binds to nothing. */
  @Column({ name: 'bound_to', type: 'text', nullable: true })
  boundTo: string | null;

  /** NULL means the bound thing's own name. */
  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'text' })
  size: WidgetSize;

  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
