import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type FormulaKind = 'physics' | 'empirical' | 'ml_feature';
export type FormulaStatus = 'proposed' | 'approved' | 'retired';

/**
 * A formula for a class of machine (`1757970000000-LibraryStructure.ts`, task QL1).
 *
 * QL1 deliberately created no entity for this table — "no services, no entities, no
 * routes... those come with the slices that consume them." QIMP2 is the first
 * consumer: a formula's `inputs` may name another formula_key, and checking that
 * needs to read what formulas the catalog already has for a class.
 *
 * Platform-owned, versioned with the class it belongs to via (class_slug,
 * class_version). The expression is stored, never evaluated, here or anywhere yet.
 */
@Entity('equipment_class_formula')
export class EquipmentClassFormula {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'class_slug', type: 'text' })
  classSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ name: 'formula_key', type: 'text' })
  formulaKey: string;

  @Column({ type: 'text' })
  kind: FormulaKind;

  @Column({ type: 'text' })
  expression: string;

  @Column({ type: 'text', array: true, default: '{}' })
  inputs: string[];

  @Column({ name: 'output_unit', type: 'text', nullable: true })
  outputUnit: string | null;

  @Column({ type: 'text', nullable: true })
  basis: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  references: unknown[];

  @Column({ type: 'text', default: 'proposed' })
  status: FormulaStatus;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'int', default: 1 })
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Written by the approval step, never by the importer. */
  @Column({ name: 'compiled_plan', type: 'jsonb', nullable: true })
  compiledPlan: Record<string, unknown> | null;

  @Column({ name: 'compiled_at', type: 'timestamptz', nullable: true })
  compiledAt: Date | null;

  @Column({ name: 'compiler_version', type: 'text', nullable: true })
  compilerVersion: string | null;

  /** `'manual'` unless written by an import; see `1757990000000-CatalogImportProvenance.ts`. */
  @Column({ type: 'text', default: 'manual' })
  source: 'manual' | 'excel-import';

  @Column({ name: 'import_batch_id', type: 'uuid', nullable: true })
  importBatchId: string | null;
}
