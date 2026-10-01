import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  FormulaAggregationWindow, FormulaChartType, FormulaComparisonBasis, FormulaKind,
  FormulaResultKind, FormulaTargetDirection,
} from '../../catalog/entities/equipment-class-formula.entity';
import { ClientCatalogStatus } from './client-equipment-class.entity';

/**
 * A client's own copy of a class formula (task QGRANT0 — see ClientEquipmentClass
 * for the model this follows).
 *
 * Copied as data, exactly as `compiled_plan` already was on the platform row: the
 * compiled plan, the result metadata, and the named-formula provenance all travel
 * here as values, never as a reference the tenant could resolve against
 * `named_formula` at runtime. Publishing a new named-formula version changes
 * nothing already copied — the same rule that already governs a class template
 * update not reaching an existing `ClientEquipmentClass`.
 */
@Entity('client_formula')
@Index('uq_client_formula', ['tenantId', 'clientEquipmentClassSlug', 'formulaKey'], { unique: true })
@Index('ix_client_formula_class', ['tenantId', 'clientEquipmentClassSlug'])
export class ClientFormula {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** References the client's own class by slug, not the template's — same
   * convention as `ClientScenario.clientEquipmentClassSlug`. */
  @Column({ name: 'client_equipment_class_slug', type: 'text' })
  clientEquipmentClassSlug: string;

  @Column({ name: 'formula_key', type: 'text' })
  formulaKey: string;

  @Column({ type: 'text' })
  kind: FormulaKind;

  /** The substituted, compilable text — identical to what the platform row holds,
   * never the role-named original (see `substituteExpression` in QCE3). */
  @Column({ type: 'text' })
  expression: string;

  @Column({ name: 'compiled_plan', type: 'jsonb', nullable: true })
  compiledPlan: Record<string, unknown> | null;

  @Column({ name: 'compiled_at', type: 'timestamptz', nullable: true })
  compiledAt: Date | null;

  @Column({ name: 'compiler_version', type: 'text', nullable: true })
  compilerVersion: string | null;

  @Column({ name: 'result_unit', type: 'text', nullable: true })
  resultUnit: string | null;

  @Column({ name: 'required_signals', type: 'text', array: true, default: '{}' })
  requiredSignals: string[];

  @Column({ name: 'required_parameters', type: 'text', array: true, default: '{}' })
  requiredParameters: string[];

  /** Recorded provenance only (task QCE3/QGRANT0) — which physics this formula
   * used, and at which published version, at the moment it was copied. Never
   * resolved against `named_formula` again; a tenant has no read path to that
   * table at all. */
  @Column({ name: 'named_formula_slug', type: 'text', nullable: true })
  namedFormulaSlug: string | null;

  @Column({ name: 'named_formula_version', type: 'int', nullable: true })
  namedFormulaVersion: number | null;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  bindings: { role: string; signal: string }[];

  // ------------------------------------------------- KPI presentation (D30), copied as-is

  @Column({ name: 'result_kind', type: 'text', nullable: true })
  resultKind: FormulaResultKind | null;

  @Column({ name: 'display_unit', type: 'text', nullable: true })
  displayUnit: string | null;

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

  // ------------------------------------------------------------------ provenance

  /** The class version this formula was copied from — same role `templateVersion`
   * plays on `ClientEquipmentClass`, not a separate formula-level version. */
  @Column({ name: 'template_version', type: 'int', nullable: true })
  templateVersion: number | null;

  @Column({ name: 'copied_at', type: 'timestamptz', nullable: true })
  copiedAt: Date | null;

  @Column({ type: 'text', default: 'active' })
  status: ClientCatalogStatus;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
