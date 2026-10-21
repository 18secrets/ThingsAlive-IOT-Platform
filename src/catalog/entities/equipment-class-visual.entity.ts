import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The twin's tiers that have an asset (D38). `list` needs none and is not stored. */
export type VisualTier = 'schematic' | 'model';

/** `numeric` arrives from the driver as a string; a hotspot is a number. */
export const numericPercent = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/**
 * A class's picture — tier 0, the schematic (`1758500000000-ClassVisuals.ts`, task
 * QREC0c) — or its 3-D model (`1761400000000-TwinModel.ts`, task QTWIN1). One per
 * class version and tier. Platform-owned and shared: every tenant with the class reads
 * this row and the one object it names; nobody gets a copy of the bytes.
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
  tier: VisualTier;

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

  /** The model tier only: which mesh this is, so a tenant marker placed on another can
   * be told apart (D39). Follows the bytes, not the class version. */
  @Column({ name: 'geometry_version', type: 'int', nullable: true })
  geometryVersion: number | null;

  /** The model tier only: its bounding box in model units, as the console measured it. */
  @Column({ name: 'bounds_min_x', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMinX: number | null;

  @Column({ name: 'bounds_min_y', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMinY: number | null;

  @Column({ name: 'bounds_min_z', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMinZ: number | null;

  @Column({ name: 'bounds_max_x', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMaxX: number | null;

  @Column({ name: 'bounds_max_y', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMaxY: number | null;

  @Column({ name: 'bounds_max_z', type: 'numeric', nullable: true, transformer: numericPercent })
  boundsMaxZ: number | null;

  @Column({ name: 'uploaded_by', type: 'text', nullable: true })
  uploadedBy: string | null;

  @Column({ name: 'uploaded_at', type: 'timestamptz', nullable: true })
  uploadedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** One marker per declared signal and tier: in percent of the image on the schematic,
 * in model units on the model. */
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

  @Column({ type: 'text', default: 'schematic' })
  tier: VisualTier;

  // Null on the schematic, set on the model — and the reverse for the hotspots, which
  // only the schematic's readers touch (they read tier 'schematic' alone).
  @Column({ name: 'pos_x', type: 'numeric', nullable: true, transformer: numericPercent })
  posX: number | null;

  @Column({ name: 'pos_y', type: 'numeric', nullable: true, transformer: numericPercent })
  posY: number | null;

  @Column({ name: 'pos_z', type: 'numeric', nullable: true, transformer: numericPercent })
  posZ: number | null;

  @Column({ type: 'text', nullable: true })
  label: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
