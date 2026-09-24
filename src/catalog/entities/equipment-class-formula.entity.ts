import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type FormulaKind = 'physics' | 'empirical' | 'ml_feature';
export type FormulaStatus = 'proposed' | 'approved' | 'retired';
export type FormulaResultKind = 'scalar' | 'series';
export type FormulaTargetDirection = 'higher_better' | 'lower_better' | 'band' | 'none';
export type FormulaComparisonBasis = 'none' | 'previous_period' | 'target';
export type FormulaAggregationWindow = 'shift' | 'today' | '24h' | '7d' | '30d' | 'mtd' | 'ytd';
export type FormulaChartType = 'none' | 'line' | 'bar' | 'area' | 'gauge';

/**
 * A formula for a class of machine (`1757970000000-LibraryStructure.ts`, task QL1).
 *
 * QL1 deliberately created no entity for this table — "no services, no entities, no
 * routes... those come with the slices that consume them." QIMP2 was the first
 * consumer. QCE1 is the first to evaluate `expression` at all — into a
 * `compiled_plan`, never executed here either; that is QCE2's job.
 *
 * Platform-owned, versioned with the class it belongs to via (class_slug,
 * class_version).
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

  /** Written by the compiler at publish, never by the importer (task QCE1) — see
   * `src/catalog/formula/formula-compiler.ts`. */
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

  // ------------------------------------------------------ KPI presentation (QCE1)
  // Author-declared, checked against the compiler's inference at publish — a
  // formula whose declared result_kind or display_unit disagrees with what it
  // actually computes is refused, not silently trusted.

  @Column({ name: 'result_kind', type: 'text', default: 'scalar' })
  resultKind: FormulaResultKind;

  /** The unit the author intends. Null until somebody sets one — there is no unit
   * that is correct for an existing row by construction. */
  @Column({ name: 'display_unit', type: 'text', nullable: true })
  displayUnit: string | null;

  /** e.g. `number:1`, `percent:1`, `currency`. */
  @Column({ name: 'display_format', type: 'text', default: 'number:1' })
  displayFormat: string;

  @Column({ name: 'target_value', type: 'double precision', nullable: true })
  targetValue: number | null;

  @Column({ name: 'target_min', type: 'double precision', nullable: true })
  targetMin: number | null;

  @Column({ name: 'target_max', type: 'double precision', nullable: true })
  targetMax: number | null;

  @Column({ name: 'target_direction', type: 'text', default: 'none' })
  targetDirection: FormulaTargetDirection;

  @Column({ name: 'comparison_basis', type: 'text', default: 'none' })
  comparisonBasis: FormulaComparisonBasis;

  @Column({ name: 'aggregation_window', type: 'text', default: 'shift' })
  aggregationWindow: FormulaAggregationWindow;

  @Column({ name: 'chart_type', type: 'text', default: 'none' })
  chartType: FormulaChartType;

  // --------------------------------------------------- derived at compile (QCE1)
  // Never author-supplied — see formula-compiler.ts. required_parameters is what
  // QPARAM1 reads.

  @Column({ name: 'result_unit', type: 'text', nullable: true })
  resultUnit: string | null;

  @Column({ name: 'required_signals', type: 'text', array: true, default: '{}' })
  requiredSignals: string[];

  @Column({ name: 'required_parameters', type: 'text', array: true, default: '{}' })
  requiredParameters: string[];
}
