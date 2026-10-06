import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** `numeric` arrives from the driver as a string; a hotspot is a number. */
export const numericPercent = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/**
 * A class's picture — tier 0, the schematic (`1758400000000-ClassVisuals.ts`, task
 * QREC0c). One per class version. Platform-owned and shared: every tenant with the
 * class reads this row and the one object it names; nobody gets a copy of the bytes.
 *
 * `pending_key` is what an issued upload URL points at; `asset_key` is set only once
 * the confirm call has seen the object exist.
 */
@Entity('equipment_class_visual')
export class EquipmentClassVisual {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ type: 'text', default: 'schematic' })
  tier: 'schematic';

  @Column({ name: 'asset_key', type: 'text', nullable: true })
  assetKey: string | null;

  @Column({ name: 'content_type', type: 'text', nullable: true })
  contentType: string | null;

  @Column({ name: 'width_px', type: 'int', nullable: true })
  widthPx: number | null;

  @Column({ name: 'height_px', type: 'int', nullable: true })
  heightPx: number | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true, transformer: numericPercent })
  sizeBytes: number | null;

  @Column({ name: 'pending_key', type: 'text', nullable: true })
  pendingKey: string | null;

  @Column({ name: 'pending_content_type', type: 'text', nullable: true })
  pendingContentType: string | null;

  @Column({ name: 'uploaded_by', type: 'text', nullable: true })
  uploadedBy: string | null;

  @Column({ name: 'uploaded_at', type: 'timestamptz', nullable: true })
  uploadedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** One marker per declared signal, in percent of the image. */
@Entity('equipment_class_visual_anchor')
export class EquipmentClassVisualAnchor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ type: 'text' })
  signal: string;

  @Column({ name: 'hotspot_x', type: 'numeric', transformer: numericPercent })
  hotspotX: number;

  @Column({ name: 'hotspot_y', type: 'numeric', transformer: numericPercent })
  hotspotY: number;

  @Column({ type: 'text', nullable: true })
  label: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
