import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { RoleInput } from '../formula/named-formula-binding';

export type NamedFormulaStatus = 'draft' | 'published';
export type NamedFormulaResultKind = 'scalar' | 'series';

/**
 * Physics, authored once, shared by every class that needs it (task QCE3, D33).
 *
 * `fuel_consumption / engine_runtime` is the same formula on an excavator, a crane
 * and a generator. Without this it is re-transcribed on each, by hand, in an
 * expression column — forty classes, forty transcriptions, no way to correct a
 * mistake everywhere at once. The split: this table is platform knowledge, published
 * and immutable, exactly like `equipment_class_profile`; which class uses it and
 * how is `equipment_class_formula.named_formula_slug/version/bindings` — class
 * content, not platform content.
 *
 * `expression` is written against **roles** (`fuel_rate / power_output`), never
 * signal names — a role is bound to an actual signal per class, in the Excel
 * `formula` sheet's bind mode. No tenant column: like `equipment_class_profile`,
 * this is Things Alive's own library, never a tenant's to edit.
 */
@Entity('named_formula')
@Index('uq_named_formula_version', ['slug', 'version'], { unique: true })
export class NamedFormula {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  @Index('ix_named_formula_slug')
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  category: string | null;

  @Column({ type: 'text' })
  expression: string;

  /** Ordered role declarations — see `RoleInput` in `named-formula-binding.ts`. The
   * order is presentational (it is what the console's binding form renders in), not
   * load-bearing: resolution is by role name, never by position. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  inputs: RoleInput[];

  /**
   * Checked against the compiler's inference at publish, never trusted (D32's
   * pattern, applied here exactly as `equipment_class_formula.result_kind` and
   * `display_unit` already use it): NULL means infer, and the inferred value is
   * what gets persisted. A DEFAULT here would turn "nobody said" into "somebody
   * said scalar" and refuse legitimate content for disagreeing with a value no
   * author ever declared.
   */
  @Column({ name: 'result_dimension', type: 'text', nullable: true })
  resultDimension: string | null;

  @Column({ name: 'result_kind', type: 'text', nullable: true })
  resultKind: NamedFormulaResultKind | null;

  @Column({ type: 'text', default: 'draft' })
  @Index('ix_named_formula_status')
  status: NamedFormulaStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // --------------------------------------------------- derived at compile (QCE3)
  // Never author-supplied — written by the same compiler path `equipment_class_
  // formula` uses, at publish, from `CompiledFormula` (formula-compiler.ts).

  @Column({ name: 'compiled_plan', type: 'jsonb', nullable: true })
  compiledPlan: Record<string, unknown> | null;

  @Column({ name: 'compiled_at', type: 'timestamptz', nullable: true })
  compiledAt: Date | null;

  @Column({ name: 'compiler_version', type: 'text', nullable: true })
  compilerVersion: string | null;

  @Column({ name: 'result_unit', type: 'text', nullable: true })
  resultUnit: string | null;
}
