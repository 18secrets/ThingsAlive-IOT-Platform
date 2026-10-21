import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { numericPercent, VisualTier } from '../../catalog/entities/equipment-class-visual.entity';

/**
 * A tenant's own anchor set for a class visual (task QREC0c). The image stays the
 * platform's; the markers are rows, copied on grant, and the tenant's to move.
 * `placementCustom` is what a new class version respects instead of reverting.
 */
@Entity('client_equipment_class_visual_anchor')
export class ClientEquipmentClassVisualAnchor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ type: 'text' })
  signal: string;

  @Column({ name: 'hotspot_x', type: 'numeric', transformer: numericPercent })
  hotspotX: number;

  @Column({ name: 'hotspot_y', type: 'numeric', transformer: numericPercent })
  hotspotY: number;

  /** Which asset the marker sits on: the schematic (hotspots) or the model (pos_*), task QTWIN1. */
  @Column({ type: 'text', default: 'schematic' })
  tier: VisualTier;

  @Column({ name: 'pos_x', type: 'numeric', nullable: true, transformer: numericPercent })
  posX: number | null;

  @Column({ name: 'pos_y', type: 'numeric', nullable: true, transformer: numericPercent })
  posY: number | null;

  @Column({ name: 'pos_z', type: 'numeric', nullable: true, transformer: numericPercent })
  posZ: number | null;

  @Column({ type: 'text', nullable: true })
  label: string | null;

  @Column({ name: 'placement_custom', type: 'boolean', default: false })
  placementCustom: boolean;

  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  /** A class upgrade changed the schematic under a tenant-placed anchor (task QUPGRADE1):
   * its position is kept, but it may now point at the wrong part of the picture. */
  @Column({ name: 'needs_recheck', type: 'boolean', default: false })
  needsRecheck: boolean;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
