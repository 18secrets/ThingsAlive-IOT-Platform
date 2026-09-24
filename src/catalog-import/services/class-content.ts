import { EntityManager } from 'typeorm';
import { EquipmentClassFormula, FormulaKind } from '../../catalog/entities/equipment-class-formula.entity';
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
  expression: string;
  inputs: string[];
  outputUnit: string | null;
  basis: string | null;
  references: unknown;
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
