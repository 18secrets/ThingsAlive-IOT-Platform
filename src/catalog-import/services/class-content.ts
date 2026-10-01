import { EntityManager } from 'typeorm';
import { EquipmentClassFormula, FormulaKind } from '../../catalog/entities/equipment-class-formula.entity';
import { parseBindings } from '../../catalog/formula/named-formula-binding';
import { EquipmentClassProfile, ExpectedSignal, FailureMode } from '../../catalog/entities/equipment-class-profile.entity';
import {
  EquipmentClassSensorRequirement, SensorRequirementCriticality,
} from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';

export interface ThresholdEntry {
  min?: number;
  max?: number;
  unit?: string;
  severity?: string;
}

export interface SensorRequirementContent {
  measurementRole: string;
  componentScope: string;
  criticality: SensorRequirementCriticality;
  minCount: number;
  canonicalUnit: string | null;
  enables: string[];
  notes: string | null;
}

export interface FormulaContent {
  formulaKey: string;
  kind: FormulaKind;
  /** The role-named text as written for a bind-mode row, until publish substitutes
   * the bound signals in and compiles it (task QCE3) — same lifecycle an
   * expression-mode row already has: nothing is compiled before publish. */
  expression: string;
  inputs: string[];
  outputUnit: string | null;
  basis: string | null;
  references: unknown;
  /** NULL on an expression-mode row. Set together with `bindings`, or not at all. */
  namedFormulaSlug: string | null;
  namedFormulaVersion: number | null;
  bindings: { role: string; signal: string }[];
}

export interface ClassContent {
  name: string;
  description: string | null;
  category: string | null;
  serviceIntervalHours: number | null;
  expectedSignals: ExpectedSignal[];
  failureModes: FailureMode[];
  defaultThresholds: Record<string, ThresholdEntry>;
  sensorRequirements: SensorRequirementContent[];
  formulas: FormulaContent[];
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strOrNull = (v: unknown): string | null => { const s = str(v).trim(); return s || null; };
export const num = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const emptyContent = (slug: string): ClassContent => ({
  name: slug, description: null, category: null, serviceIntervalHours: null,
  expectedSignals: [], failureModes: [], defaultThresholds: {}, sensorRequirements: [], formulas: [],
});

/**
 * The current version's content, in the same shape a batch's rows get turned into —
 * so a batch can be compared against it field by field (task QIMP3).
 */
export async function loadCurrentClass(
  m: EntityManager, slug: string,
): Promise<{ current: EquipmentClassProfile | null; content: ClassContent }> {
  const current = await m.getRepository(EquipmentClassProfile).findOne({
    where: { slug }, order: { version: 'DESC' },
  });
  if (!current) return { current: null, content: emptyContent(slug) };

  const [reqs, formulas] = await Promise.all([
    m.getRepository(EquipmentClassSensorRequirement).find({
      where: { classSlug: slug, classVersion: current.version },
    }),
    m.getRepository(EquipmentClassFormula).find({ where: { classSlug: slug, classVersion: current.version } }),
  ]);

  return {
    current,
    content: {
      name: current.name, description: current.description, category: current.category,
      serviceIntervalHours: current.serviceIntervalHours,
      expectedSignals: current.expectedSignals, failureModes: current.failureModes,
      defaultThresholds: (current.defaultThresholds ?? {}) as Record<string, ThresholdEntry>,
      sensorRequirements: reqs.map((r) => ({
        measurementRole: r.measurementRole, componentScope: r.componentScope, criticality: r.criticality,
        minCount: r.minCount, canonicalUnit: r.canonicalUnit, enables: r.enables, notes: r.notes,
      })),
      formulas: formulas.map((f) => ({
        formulaKey: f.formulaKey, kind: f.kind, expression: f.expression, inputs: f.inputs,
        outputUnit: f.outputUnit, basis: f.basis, references: f.references,
        namedFormulaSlug: f.namedFormulaSlug, namedFormulaVersion: f.namedFormulaVersion, bindings: f.bindings,
      })),
    },
  };
}

/**
 * What a batch would write for one class, sheet by sheet.
 *
 * A sheet the batch has no valid rows for is not "cleared" — it is inherited from the
 * current version unchanged, because a workbook that only fixes one row is not
 * declaring "delete everything else this class had".
 *
 * Template v3 merges expected_signal, sensor_requirement and default_threshold into
 * one `signal` sheet, so "no valid rows for a logical entity" is judged per entity,
 * not per physical sheet: presence of any `signal` row still replaces expectedSignals
 * wholesale, but sensorRequirements and defaultThresholds each replace only when a
 * `signal` row actually supplies criticality, or a min/max, respectively.
 */
export function buildProposedClass(rows: CatalogImportRow[], current: ClassContent): ClassContent {
  const byS = (sheet: string) => rows.filter((r) => r.sheet === sheet);
  const classRow = byS('equipment_class')[0];
  const signalRows = byS('signal');
  const modeRows = byS('failure_mode');
  const formulaRows = byS('formula');

  const reqRows = signalRows.filter((r) => strOrNull(r.payload.criticality));
  const thresholdRows = signalRows.filter((r) => num(r.payload.min) !== undefined || num(r.payload.max) !== undefined);

  // Signal-level columns (unit, required, description, min, max, severity) already
  // agree across every row sharing (class_slug, signal) — CatalogImportValidatorService
  // rejects the batch otherwise — so the first row for a signal speaks for the group,
  // and an expected_signals entry or threshold is written once per signal, not once
  // per component row.
  const firstPerSignal = (list: CatalogImportRow[]): CatalogImportRow[] => {
    const bySignal = new Map<string, CatalogImportRow>();
    for (const r of list) {
      const key = str(r.payload.signal);
      if (!bySignal.has(key)) bySignal.set(key, r);
    }
    return [...bySignal.values()];
  };

  return {
    name: classRow ? str(classRow.payload.name) : current.name,
    description: classRow ? strOrNull(classRow.payload.description) : current.description,
    category: classRow ? strOrNull(classRow.payload.category) : current.category,
    serviceIntervalHours: classRow
      ? num(classRow.payload.service_interval_hours) ?? null
      : current.serviceIntervalHours,
    expectedSignals: signalRows.length
      ? firstPerSignal(signalRows).map((r) => ({
          signal: str(r.payload.signal), unit: strOrNull(r.payload.unit),
          required: r.payload.required === true, description: strOrNull(r.payload.description) ?? undefined,
        }))
      : current.expectedSignals,
    failureModes: modeRows.length
      ? modeRows.map((r) => ({
          code: str(r.payload.code), name: str(r.payload.name), symptom: str(r.payload.symptom),
          signals: (r.payload.signals as string[] | undefined) ?? [],
        }))
      : current.failureModes,
    defaultThresholds: thresholdRows.length
      ? Object.fromEntries(firstPerSignal(thresholdRows).map((r) => {
          const entry: ThresholdEntry = {};
          const min = num(r.payload.min); if (min !== undefined) entry.min = min;
          const max = num(r.payload.max); if (max !== undefined) entry.max = max;
          const unit = strOrNull(r.payload.unit); if (unit) entry.unit = unit;
          const severity = strOrNull(r.payload.severity); if (severity) entry.severity = severity;
          return [str(r.payload.signal), entry];
        }))
      : current.defaultThresholds,
    sensorRequirements: reqRows.length
      ? reqRows.map((r) => ({
          measurementRole: str(r.payload.signal), componentScope: str(r.payload.component_scope),
          criticality: (strOrNull(r.payload.criticality) as SensorRequirementCriticality) ?? 'required',
          minCount: num(r.payload.min_count) ?? 1,
          canonicalUnit: strOrNull(r.payload.unit),
          enables: (r.payload.enables as string[] | undefined) ?? [],
          notes: strOrNull(r.payload.notes),
        }))
      : current.sensorRequirements,
    formulas: formulaRows.length
      ? formulaRows.map((r) => ({
          formulaKey: str(r.payload.formula_key), kind: str(r.payload.kind) as FormulaKind,
          expression: str(r.payload.expression), inputs: (r.payload.inputs as string[] | undefined) ?? [],
          outputUnit: strOrNull(r.payload.output_unit), basis: strOrNull(r.payload.basis),
          references: parseReferences(r.payload.references),
          // Bind mode (task QCE3): carried through as data. Resolved against the
          // named formula, substituted and compiled at publish, never here —
          // buildProposedClass stays synchronous and makes no DB read, the same as
          // every other field it assembles.
          namedFormulaSlug: strOrNull(r.payload.named_formula),
          namedFormulaVersion: num(r.payload.named_formula_version) ?? null,
          bindings: parseBindings(str(r.payload.bindings)),
        }))
      : current.formulas,
  };
}

/**
 * The cell holds a JSON array as text (`'[]'`, `'["ISO 10816-3"]'`); what actually
 * gets persisted is the parsed array. Parsing here, not just at write time, is what
 * lets a freshly-parsed batch compare equal to a class already written from one —
 * without it, `references: '[]'` (a batch row's raw string) never equals
 * `references: []` (the array a previous apply actually stored), and re-uploading an
 * unchanged workbook always looks like a change.
 */
function parseReferences(value: unknown): unknown[] {
  const s = strOrNull(value);
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A stable, order-independent fingerprint — field by field, not row by row. */
export function canonicalizeClass(content: ClassContent): string {
  const signals = [...content.expectedSignals]
    .map((s) => ({ signal: s.signal, unit: s.unit, required: s.required, description: s.description ?? null }))
    .sort((a, b) => a.signal.localeCompare(b.signal));
  const modes = [...content.failureModes]
    .map((m) => ({ code: m.code, name: m.name, symptom: m.symptom, signals: [...m.signals].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const reqs = [...content.sensorRequirements]
    .map((r) => ({ ...r, enables: [...r.enables].sort() }))
    .sort((a, b) => `${a.measurementRole}::${a.componentScope}`.localeCompare(`${b.measurementRole}::${b.componentScope}`));
  const formulas = [...content.formulas]
    .map((f) => ({ ...f, inputs: [...f.inputs].sort() }))
    .sort((a, b) => a.formulaKey.localeCompare(b.formulaKey));
  const thresholds = Object.fromEntries(Object.entries(content.defaultThresholds).sort(([a], [b]) => a.localeCompare(b)));

  return JSON.stringify({
    name: content.name, description: content.description, category: content.category,
    serviceIntervalHours: content.serviceIntervalHours,
    expectedSignals: signals, failureModes: modes, defaultThresholds: thresholds,
    sensorRequirements: reqs, formulas,
  });
}

export function classesIdentical(a: ClassContent, b: ClassContent): boolean {
  return canonicalizeClass(a) === canonicalizeClass(b);
}

export type ClassDiffWarning = 'incomplete_class' | 'content_regression';

export interface PreviousPublishedVersion {
  version: number;
  signalCount: number;
  failureModeCount: number;
}

export interface ClassDiffEntry {
  slug: string;
  action: 'create' | 'new_version' | 'unchanged';
  countsBySheet: Record<string, number>;
  signalsInWorkbook: number;
  signalsToApply: number;
  rejectedRows: number;
  previousPublishedVersion: PreviousPublishedVersion | null;
  warnings: ClassDiffWarning[];
}

/**
 * What a class's dry-run diff says, and what apply refuses on — the same computation
 * for both, so they cannot disagree about whether a batch is safe to write (task
 * QIMP4). Neither reads a workbook file; both work from rows already staged.
 *
 * `signalsInWorkbook` counts every distinct signal name the workbook asked for on
 * this class, valid or not — a row rejected for a bad unit is still something the
 * author intended to declare. `signalsToApply` counts what would actually be
 * written. The gap between them is `incomplete_class`: "some rows were rejected"
 * and "this class is about to publish with 1 of its 26 signals" read identically
 * unless the diff says so in numbers.
 *
 * `content_regression` compares against the class's last *published* version
 * specifically, not merely its latest row (`loadCurrentClass` returns the latest
 * version regardless of status) — a draft nobody published yet is not content this
 * import would be destroying. This is the `ex-1200v` case: six failure modes in the
 * published v1, none in the v2 this batch proposes, and nothing said so until now.
 */
export async function computeClassDiffEntry(
  m: EntityManager,
  slug: string,
  allRowsForClass: CatalogImportRow[],
  validRowsForClass: CatalogImportRow[],
  current: EquipmentClassProfile | null,
  currentContent: ClassContent,
  action: ClassDiffEntry['action'],
): Promise<ClassDiffEntry> {
  const countsBySheet: Record<string, number> = {};
  for (const r of validRowsForClass) countsBySheet[r.sheet] = (countsBySheet[r.sheet] ?? 0) + 1;

  const signalsInWorkbook = new Set(
    allRowsForClass.filter((r) => r.sheet === 'signal').map((r) => str(r.payload.signal)),
  ).size;

  const proposed = buildProposedClass(validRowsForClass, currentContent);
  const signalsToApply = proposed.expectedSignals.length;
  const rejectedRows = allRowsForClass.filter((r) => r.status === 'invalid').length;

  // The class's own history, not `current` — a class only ever created as drafts
  // has no published version to regress from, however many drafts it has been through.
  const publishedRepo = m.getRepository(EquipmentClassProfile);
  const lastPublished = await publishedRepo.findOne({
    where: { slug, status: 'published' }, order: { version: 'DESC' },
  });
  const previousPublishedVersion: PreviousPublishedVersion | null = lastPublished ? {
    version: lastPublished.version,
    signalCount: lastPublished.expectedSignals.length,
    failureModeCount: lastPublished.failureModes.length,
  } : null;

  const warnings: ClassDiffWarning[] = [];
  if (signalsToApply < signalsInWorkbook) warnings.push('incomplete_class');
  if (previousPublishedVersion) {
    const proposedFailureModes = proposed.failureModes.length;
    if (signalsToApply < previousPublishedVersion.signalCount
      || proposedFailureModes < previousPublishedVersion.failureModeCount) {
      warnings.push('content_regression');
    }
  }

  return {
    slug, action, countsBySheet, signalsInWorkbook, signalsToApply, rejectedRows,
    previousPublishedVersion, warnings,
  };
}
