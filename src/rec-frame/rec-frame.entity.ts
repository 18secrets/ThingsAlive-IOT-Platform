import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type FrameRenderer = 'template' | 'model';
export type FrameValidation = 'passed' | 'refused';

/** One rendering of one evidence bundle (task QREC2). See `1761200000000-RecFrame.ts`. */
@Entity('rec_frame')
export class RecFrame {
  /** The answer_id: derived from what was rendered, so a re-render has the same id. */
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'bundle_id', type: 'uuid' })
  bundleId: string;

  @Column({ type: 'text' })
  renderer: FrameRenderer;

  @Column({ name: 'renderer_version', type: 'text' })
  rendererVersion: string;

  @Column({ name: 'model_id', type: 'text', nullable: true })
  modelId: string | null;

  @Column({ name: 'model_version', type: 'text', nullable: true })
  modelVersion: string | null;

  @Column({ type: 'text' })
  validation: FrameValidation;

  @Column({ name: 'refused_checks', type: 'text', array: true })
  refusedChecks: string[];

  @Column({ type: 'jsonb', nullable: true })
  answer: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
