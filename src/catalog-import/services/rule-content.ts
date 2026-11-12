import { EntityManager, In } from 'typeorm';
import { AlertParams, AlertTrigger, validateParams } from '../../alert/services/alert-rules';
import { AlertRuleTemplate } from '../../catalog/entities/alert-rule-template.entity';
import { ScenarioDefinition, ScenarioParameter, ScenarioTier } from '../../catalog/entities/scenario-definition.entity';
import { Severity } from '../../common/severity';
import { CausalChainDefinition } from '../../intelligence/entities/causal-chain.entity';
import { ChainDriver, ChainNode, Direction } from '../../intelligence/services/causal-chain';
import { validateChain } from '../../intelligence/services/chain.service';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import {
  CHAIN_ALERT_LEVELS, CHAIN_DIRECTION_VALUES, IMPORTABLE_TRIGGERS, SCENARIO_TIER_VALUES, SEVERITY_VALUES,
} from '../template-schema';

/**
 * The rule sheets of a catalog workbook (testing sheet TC_126): prediction scenarios,
 * alert rules and causal chains, each landing as a library draft beside its class.
 *
 * Kept apart from class-content.ts on purpose. A class is versioned as one body — a
 * workbook that names it replaces its signals, failure modes and formulas together —
 * while each of these is its own versioned row with its own slug, as on the class
 * page. Grouped with the class, a workbook carrying only rules would read as a class
 * with every signal removed.
 *
 * What an existing slug gets (decided with the product owner, 12 Nov): unchanged
 * content is left alone; over a published version, a new draft version; over a draft,
 * nothing — a draft may hold an author's edits, so the row is reported as a conflict
 * rather than overwritten. Plan and apply share `planRuleRows`, so the diff cannot
 * promise what apply then does differently.
 */
export const RULE_SHEETS = ['prediction_scenario', 'alert_rule', 'causal_chain', 'causal_chain_stage'];
export const isRuleSheet = (sheet: string): boolean => RULE_SHEETS.includes(sheet);

type Cell = unknown;
const text = (v: Cell): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const textOrNull = (v: Cell): string | null => text(v) || null;

/** undefined for a blank cell; NaN for one that is not a number, so the caller can say which. */
function num(v: Cell): number | undefined {
  const s = text(v);
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** "signal=coefficient@lagSeconds; signal=coefficient", or the reason it is not. */
export function parseDrivers(cell: Cell): ChainDriver[] | string {
  const parts = text(cell).split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return 'drivers is blank; write "signal=coefficient", or "signal=coefficient@seconds" with a lag.';
  const drivers: ChainDriver[] = [];
  for (const part of parts) {
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*(?:@\s*([0-9]+))?$/i.exec(part);
    if (!m || !Number.isFinite(Number(m[2]))) {
      return `driver "${part}" is not "signal=coefficient" or "signal=coefficient@seconds".`;
    }
    drivers.push({ signal: m[1], coefficient: Number(m[2]), ...(m[3] !== undefined ? { lagSeconds: Number(m[3]) } : {}) });
  }
  return drivers;
}

// ------------------------------------------------------------------ the content

interface ScenarioContent {
  equipmentClassSlug: string; name: string; description: string | null; severity: Severity; tier: ScenarioTier;
  requiredSignals: string[]; minimumHistoryDays: number; parameters: ScenarioParameter[];
}

/** The sigma columns, under the keys the scorer reads (`scenarioRule`), as tunables. */
const SIGMA_PARAMETERS: { column: string; label: string; unit?: string; min: number; max: number }[] = [
  { column: 'warning_sigma', label: 'Warning at (standard deviations)', min: 0.5, max: 10 },
  { column: 'critical_sigma', label: 'Critical at (standard deviations)', min: 0.5, max: 10 },
  { column: 'baseline_window_days', label: 'Baseline window', unit: 'days', min: 1, max: 365 },
  { column: 'minimum_samples', label: 'Minimum samples', min: 1, max: 100000 },
];

function scenarioOf(r: CatalogImportRow): ScenarioContent {
  const p = r.payload;
  const parameters: ScenarioParameter[] = [];
  for (const s of SIGMA_PARAMETERS) {
    const v = num(p[s.column]);
    if (v === undefined) continue;
    parameters.push({ key: s.column, label: s.label, type: 'number', default: v, min: s.min, max: s.max, ...(s.unit ? { unit: s.unit } : {}) });
  }
  return {
    equipmentClassSlug: text(p.class_slug), name: text(p.name), description: textOrNull(p.description),
    severity: (text(p.severity) || Severity.Medium) as Severity,
    tier: Number(text(p.tier) || 1) as ScenarioTier,
    requiredSignals: (p.required_signals as string[] | undefined) ?? [],
    minimumHistoryDays: num(p.minimum_history_days) ?? 0,
    parameters,
  };
}

interface AlertContent {
  equipmentClassSlug: string; name: string; description: string | null; trigger: AlertTrigger;
  params: AlertParams; severity: Severity; enabledOnCopy: boolean;
}

function alertOf(r: CatalogImportRow): AlertContent {
  const p = r.payload;
  const trigger = text(p.trigger) as AlertTrigger;
  let params: Record<string, unknown>;
  if (trigger === 'signal-threshold') {
    const min = num(p.min); const max = num(p.max); const rating = text(p.rating);
    params = { signal: text(p.signal), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(rating ? { rating } : {}) };
  } else if (trigger === 'prediction-severity') {
    params = { atLeast: text(p.at_least), ...(text(p.scenario_slug) ? { clientScenarioSlug: text(p.scenario_slug) } : {}) };
  } else {
    params = {
      atLeast: text(p.at_least),
      ...(text(p.chain_slug) ? { chainSlug: text(p.chain_slug) } : {}),
      ...(text(p.stage_signal) ? { stageSignal: text(p.stage_signal) } : {}),
    };
  }
  return {
    equipmentClassSlug: text(p.class_slug), name: text(p.name), description: textOrNull(p.description), trigger,
    params: params as unknown as AlertParams,
    severity: (text(p.severity) || Severity.High) as Severity,
    // The parser gives a boolean column true/false, or undefined when blank.
    enabledOnCopy: p.enabled_on_copy === undefined || p.enabled_on_copy === '' ? true : p.enabled_on_copy === true,
  };
}

interface ChainContent {
  equipmentClassSlug: string; scenarioSlug: string | null; name: string; description: string | null;
  outcome: string | null; nodes: ChainNode[]; alignmentSeconds: number | null; provenance: string | null;
}

function stageOf(r: CatalogImportRow): ChainNode {
  const p = r.payload;
  const drivers = parseDrivers(p.drivers);
  const warnAt = num(p.limit_warn_at); const criticalAt = num(p.limit_critical_at);
  const direction = text(p.direction);
  return {
    signal: text(p.signal), ...(text(p.label) ? { label: text(p.label) } : {}),
    intercept: num(p.intercept) ?? Number.NaN,
    drivers: Array.isArray(drivers) ? drivers : [],
    warnAbove: num(p.warn_above) ?? Number.NaN, criticalAbove: num(p.critical_above) ?? Number.NaN,
    ...(direction ? { direction: direction as Direction } : {}),
    ...(warnAt !== undefined || criticalAt !== undefined
      ? { limits: { ...(warnAt !== undefined ? { warnAt } : {}), ...(criticalAt !== undefined ? { criticalAt } : {}) } }
      : {}),
  };
}

function chainOf(r: CatalogImportRow, stages: CatalogImportRow[]): ChainContent {
  const p = r.payload;
  return {
    equipmentClassSlug: text(p.class_slug), scenarioSlug: textOrNull(p.scenario_slug), name: text(p.name),
    description: textOrNull(p.description), outcome: textOrNull(p.outcome),
    nodes: [...stages].sort((a, b) => a.rowNumber - b.rowNumber).map(stageOf),
    alignmentSeconds: num(p.alignment_seconds) ?? null, provenance: textOrNull(p.provenance),
  };
}

// ------------------------------------------------------------------ validation

export interface RuleValidationContext {
  live: (r: CatalogImportRow) => boolean;
  invalidate: (r: CatalogImportRow, message: string) => void;
  /** Signals the class declares: this batch's signal rows, else its latest version. */
  declaredSignals: (classSlug: string) => Set<string>;
}

/**
 * Every refusal the authoring screens make, with a row number. Ordered by what
 * depends on what: scenarios, then chains (which may name a scenario), then alert
 * rules (which may name either) — so a rule naming a scenario that was itself refused
 * is refused too, rather than drafted against nothing.
 */
export async function validateRuleRows(
  m: EntityManager, candidates: CatalogImportRow[], ctx: RuleValidationContext,
): Promise<void> {
  const { live, invalidate } = ctx;
  const sheet = (name: string) => candidates.filter((r) => r.sheet === name);
  const at = (r: CatalogImportRow) => `${r.sheet} row ${r.rowNumber}`;

  // Duplicates inside the batch, by the key each sheet is matched on.
  const dupes = (rows: CatalogImportRow[], key: (r: CatalogImportRow) => string, what: string) => {
    const groups = new Map<string, CatalogImportRow[]>();
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const numbers = group.map((r) => r.rowNumber).sort((a, b) => a - b).join(', ');
      for (const r of group) invalidate(r, `${at(r)}: ${what} appears more than once (rows ${numbers}).`);
    }
  };
  dupes(sheet('prediction_scenario'), (r) => text(r.payload.slug), 'this slug');
  dupes(sheet('alert_rule'), (r) => text(r.payload.slug), 'this slug');
  dupes(sheet('causal_chain'), (r) => text(r.payload.slug), 'this slug');
  dupes(sheet('causal_chain_stage'), (r) => `${text(r.payload.chain_slug)}::${text(r.payload.signal)}`, 'this chain and signal');

  // A slug already in the library on another class would version one class's rule
  // with another's content.
  const libraryClassOf = async <T extends { slug: string; equipmentClassSlug: string; version: number }>(
    entity: new () => T, slugs: string[],
  ): Promise<Map<string, string>> => {
    if (!slugs.length) return new Map();
    const found = await m.getRepository(entity).find({ where: { slug: In(slugs) } as never, order: { version: 'DESC' } as never });
    const map = new Map<string, string>();
    for (const row of found) if (!map.has(row.slug)) map.set(row.slug, row.equipmentClassSlug);
    return map;
  };
  const otherClass = (r: CatalogImportRow, library: Map<string, string>) => {
    const owner = library.get(text(r.payload.slug));
    if (owner && owner !== text(r.payload.class_slug)) {
      invalidate(r, `${at(r)}: "${text(r.payload.slug)}" already exists in the library on class "${owner}"; use another slug.`);
      return true;
    }
    return false;
  };
  const undeclared = (classSlug: string, signals: string[]) => {
    const declared = ctx.declaredSignals(classSlug);
    return signals.filter((s) => !declared.has(s));
  };

  // -------------------------------------------------------------- scenarios
  const scenarioRows = sheet('prediction_scenario');
  const scenarioLibrary = await libraryClassOf(ScenarioDefinition, scenarioRows.map((r) => text(r.payload.slug)));
  for (const r of scenarioRows) {
    if (!live(r) || otherClass(r, scenarioLibrary)) continue;
    const p = r.payload;
    const severity = text(p.severity);
    if (severity && !SEVERITY_VALUES.includes(severity)) { invalidate(r, `${at(r)}: "${severity}" is not a severity.`); continue; }
    const tier = text(p.tier);
    if (tier && !SCENARIO_TIER_VALUES.includes(tier)) { invalidate(r, `${at(r)}: tier must be 1, 2 or 3.`); continue; }
    const history = num(p.minimum_history_days);
    if (history !== undefined && !(Number.isInteger(history) && history >= 0)) {
      invalidate(r, `${at(r)}: minimum_history_days must be a whole number of days, 0 or more.`); continue;
    }
    const bad = SIGMA_PARAMETERS.find((s) => { const v = num(p[s.column]); return v !== undefined && !(v > 0); });
    if (bad) { invalidate(r, `${at(r)}: ${bad.column} must be a number above 0.`); continue; }
    const warning = num(p.warning_sigma); const critical = num(p.critical_sigma);
    if (warning !== undefined && critical !== undefined && critical < warning) {
      invalidate(r, `${at(r)}: critical_sigma (${critical}) is below warning_sigma (${warning}), so it would never reach critical.`);
      continue;
    }
    const missing = undeclared(text(p.class_slug), (p.required_signals as string[] | undefined) ?? []);
    if (missing.length) {
      invalidate(r, `${at(r)}: class "${text(p.class_slug)}" does not declare ${missing.join(', ')}. Add the signal to the class first.`);
    }
  }
  const liveScenarioClass = new Map(scenarioRows.filter(live).map((r) => [text(r.payload.slug), text(r.payload.class_slug)]));
  const scenarioClass = async (slug: string): Promise<string | null> =>
    liveScenarioClass.get(slug)
      ?? (await m.getRepository(ScenarioDefinition).findOne({ where: { slug }, order: { version: 'DESC' } }))?.equipmentClassSlug
      ?? null;
  const refusesScenario = async (r: CatalogImportRow, slug: string) => {
    if (!slug) return false;
    const owner = await scenarioClass(slug);
    if (owner === text(r.payload.class_slug)) return false;
    invalidate(r, owner
      ? `${at(r)}: scenario "${slug}" belongs to class "${owner}", not "${text(r.payload.class_slug)}".`
      : `${at(r)}: no scenario "${slug}" in this workbook (or it was refused) or in the library.`);
    return true;
  };

  // -------------------------------------------------------------- chains
  const chainRows = sheet('causal_chain');
  const stageRows = sheet('causal_chain_stage');
  const chainLibrary = await libraryClassOf(CausalChainDefinition, chainRows.map((r) => text(r.payload.slug)));
  const chainBySlug = new Map(chainRows.map((r) => [text(r.payload.slug), r]));
  for (const s of stageRows) {
    if (!live(s)) continue;
    const p = s.payload;
    if (!chainBySlug.has(text(p.chain_slug))) {
      invalidate(s, `${at(s)}: no causal_chain row "${text(p.chain_slug)}" in this workbook. A chain is written whole.`);
      continue;
    }
    const drivers = parseDrivers(p.drivers);
    if (typeof drivers === 'string') { invalidate(s, `${at(s)}: ${drivers}`); continue; }
    const notNumber = ['intercept', 'warn_above', 'critical_above', 'limit_warn_at', 'limit_critical_at']
      .find((c) => Number.isNaN(num(p[c]) as number));
    if (notNumber) { invalidate(s, `${at(s)}: ${notNumber} must be a number.`); continue; }
    const direction = text(p.direction);
    if (direction && !CHAIN_DIRECTION_VALUES.includes(direction)) {
      invalidate(s, `${at(s)}: direction must be ${CHAIN_DIRECTION_VALUES.join(', ')}.`);
    }
  }
  for (const r of chainRows) {
    if (!live(r) || otherClass(r, chainLibrary)) continue;
    const slug = text(r.payload.slug);
    const alignment = num(r.payload.alignment_seconds);
    if (alignment !== undefined && !(Number.isInteger(alignment) && alignment > 0)) {
      invalidate(r, `${at(r)}: alignment_seconds must be a whole number of seconds above 0.`); continue;
    }
    const stages = stageRows.filter((s) => text(s.payload.chain_slug) === slug);
    const refused = stages.filter((s) => !live(s));
    if (refused.length) {
      invalidate(r, `${at(r)}: causal_chain_stage row(s) ${refused.map((s) => s.rowNumber).join(', ')} were refused, so the chain is incomplete.`);
      continue;
    }
    if (!stages.length) { invalidate(r, `${at(r)}: no causal_chain_stage rows name "${slug}"; a chain needs at least one stage.`); continue; }
    const content = chainOf(r, stages);
    const problem = validateChain(content.nodes);
    if (problem) { invalidate(r, `${at(r)}: ${problem}`); continue; }
    const missing = undeclared(content.equipmentClassSlug, content.nodes.map((n) => n.signal));
    if (missing.length) {
      invalidate(r, `${at(r)}: class "${content.equipmentClassSlug}" does not declare stage signal(s) ${missing.join(', ')}.`);
      continue;
    }
    await refusesScenario(r, text(r.payload.scenario_slug));
  }
  // A stage stands or falls with its chain.
  for (const s of stageRows) {
    const chain = chainBySlug.get(text(s.payload.chain_slug));
    if (live(s) && chain && !live(chain)) invalidate(s, `${at(s)}: its chain "${text(s.payload.chain_slug)}" was refused.`);
  }
  const liveChain = new Map(chainRows.filter(live).map((r) => [text(r.payload.slug), r]));

  // -------------------------------------------------------------- alert rules
  const alertRows = sheet('alert_rule');
  const alertLibrary = await libraryClassOf(AlertRuleTemplate, alertRows.map((r) => text(r.payload.slug)));
  for (const r of alertRows) {
    if (!live(r) || otherClass(r, alertLibrary)) continue;
    const p = r.payload;
    const trigger = text(p.trigger);
    if (!IMPORTABLE_TRIGGERS.includes(trigger)) {
      invalidate(r, `${at(r)}: trigger must be one of ${IMPORTABLE_TRIGGERS.join(', ')}.`); continue;
    }
    const severity = text(p.severity);
    if (severity && !SEVERITY_VALUES.includes(severity)) { invalidate(r, `${at(r)}: "${severity}" is not a severity.`); continue; }
    const notNumber = ['min', 'max'].find((c) => Number.isNaN(num(p[c]) as number));
    if (notNumber) { invalidate(r, `${at(r)}: ${notNumber} must be a number.`); continue; }
    if (trigger === 'chain-origin' && text(p.at_least) && !CHAIN_ALERT_LEVELS.includes(text(p.at_least))) {
      invalidate(r, `${at(r)}: a chain rule's at_least must be warning or critical.`); continue;
    }
    const content = alertOf(r);
    const problem = validateParams(content.trigger, content.params);
    if (problem) { invalidate(r, `${at(r)}: ${problem}`); continue; }
    if (trigger === 'signal-threshold') {
      const missing = undeclared(content.equipmentClassSlug, [text(p.signal)]);
      if (missing.length) { invalidate(r, `${at(r)}: class "${content.equipmentClassSlug}" does not declare ${missing[0]}.`); continue; }
    }
    if (trigger === 'prediction-severity' && await refusesScenario(r, text(p.scenario_slug))) continue;
    if (trigger === 'chain-origin' && text(p.chain_slug)) {
      const chainSlug = text(p.chain_slug);
      const inBatch = liveChain.get(chainSlug);
      const owner = inBatch ? text(inBatch.payload.class_slug)
        : (await m.getRepository(CausalChainDefinition).findOne({ where: { slug: chainSlug }, order: { version: 'DESC' } }))?.equipmentClassSlug;
      if (owner !== content.equipmentClassSlug) {
        invalidate(r, owner
          ? `${at(r)}: chain "${chainSlug}" belongs to class "${owner}".`
          : `${at(r)}: no causal chain "${chainSlug}" in this workbook (or it was refused) or in the library.`);
        continue;
      }
      const stage = text(p.stage_signal);
      if (stage && inBatch && !stageRows.some((s) => text(s.payload.chain_slug) === chainSlug && text(s.payload.signal) === stage)) {
        invalidate(r, `${at(r)}: chain "${chainSlug}" has no stage "${stage}".`);
      }
    }
  }
}

// ------------------------------------------------------------------ plan and apply

export type RuleAction = 'create' | 'new_version' | 'unchanged' | 'conflict';
export type RuleKind = 'scenario' | 'alertRule' | 'causalChain';

export interface RulePlanEntry {
  kind: RuleKind;
  slug: string;
  classSlug: string;
  action: RuleAction;
  /** The version written (create, new_version), or the existing one it was compared with. */
  version: number;
  rows: CatalogImportRow[];
  content: ScenarioContent | AlertContent | ChainContent;
}

export interface RuleKindSummary { created: number; newVersions: number; unchanged: number; conflicts: string[] }
export type RuleApplySummary = Record<RuleKind, RuleKindSummary>;

type Versioned = { id: string; slug: string; version: number; status: string };

/** Content in a fixed key order, so equal content compares equal whatever order it was built in. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x));
const pick = <T extends object>(row: T, keys: (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

const SCENARIO_KEYS: (keyof ScenarioContent)[] = ['equipmentClassSlug', 'name', 'description', 'severity', 'tier', 'requiredSignals', 'minimumHistoryDays', 'parameters'];
const ALERT_KEYS: (keyof AlertContent)[] = ['equipmentClassSlug', 'name', 'description', 'trigger', 'params', 'severity', 'enabledOnCopy'];
const CHAIN_KEYS: (keyof ChainContent)[] = ['equipmentClassSlug', 'scenarioSlug', 'name', 'description', 'outcome', 'nodes', 'alignmentSeconds', 'provenance'];

/** What applying the valid rule rows would do, slug by slug. Read-only. */
export async function planRuleRows(m: EntityManager, validRows: CatalogImportRow[]): Promise<RulePlanEntry[]> {
  const plan: RulePlanEntry[] = [];
  const decide = async <E extends Versioned>(
    kind: RuleKind, entity: new () => E, keys: string[], row: CatalogImportRow, content: object, rows: CatalogImportRow[],
  ) => {
    const slug = text(row.payload.slug);
    const latest = await m.getRepository(entity).findOne({ where: { slug } as never, order: { version: 'DESC' } as never });
    let action: RuleAction;
    let version: number;
    if (!latest) { action = 'create'; version = 1; }
    else if (canonical(pick(latest as never, keys as never)) === canonical(pick(content as never, keys as never))) {
      action = 'unchanged'; version = latest.version;
    } else if (latest.status === 'draft') { action = 'conflict'; version = latest.version; }
    else { action = 'new_version'; version = latest.version + 1; }
    plan.push({ kind, slug, classSlug: text(row.payload.class_slug), action, version, rows, content: content as RulePlanEntry['content'] });
  };
  for (const r of validRows.filter((x) => x.sheet === 'prediction_scenario')) {
    await decide('scenario', ScenarioDefinition, SCENARIO_KEYS, r, scenarioOf(r), [r]);
  }
  const stages = validRows.filter((x) => x.sheet === 'causal_chain_stage');
  for (const r of validRows.filter((x) => x.sheet === 'causal_chain')) {
    const own = stages.filter((s) => text(s.payload.chain_slug) === text(r.payload.slug));
    await decide('causalChain', CausalChainDefinition, CHAIN_KEYS, r, chainOf(r, own), [r, ...own]);
  }
  for (const r of validRows.filter((x) => x.sheet === 'alert_rule')) {
    await decide('alertRule', AlertRuleTemplate, ALERT_KEYS, r, alertOf(r), [r]);
  }
  return plan;
}

export function summarizeRulePlan(plan: RulePlanEntry[]): RuleApplySummary {
  const empty = (): RuleKindSummary => ({ created: 0, newVersions: 0, unchanged: 0, conflicts: [] });
  const summary: RuleApplySummary = { scenario: empty(), alertRule: empty(), causalChain: empty() };
  for (const e of plan) {
    const s = summary[e.kind];
    if (e.action === 'create') s.created += 1;
    else if (e.action === 'new_version') s.newVersions += 1;
    else if (e.action === 'unchanged') s.unchanged += 1;
    else s.conflicts.push(e.slug);
  }
  return summary;
}

/**
 * Writes the plan, inside apply's transaction and under its batch lock. Every write is
 * an insert of a version nothing has been written under: `(slug, version)` is unique
 * in all three tables, so a second batch racing this one for the same slug is refused
 * by the database rather than writing a second v2.
 */
export async function applyRuleRows(
  m: EntityManager, validRows: CatalogImportRow[], createdBy: string,
): Promise<RuleApplySummary> {
  const plan = await planRuleRows(m, validRows);
  for (const e of plan) {
    let id: string | null = null;
    if (e.action === 'create' || e.action === 'new_version') {
      const base = { slug: e.slug, version: e.version, status: 'draft' as const, publishedAt: null };
      if (e.kind === 'scenario') {
        const repo = m.getRepository(ScenarioDefinition);
        id = (await repo.save(repo.create({ ...base, ...(e.content as ScenarioContent) }))).id;
      } else if (e.kind === 'alertRule') {
        const repo = m.getRepository(AlertRuleTemplate);
        id = (await repo.save(repo.create({ ...base, ...(e.content as AlertContent), createdBy }))).id;
      } else {
        const repo = m.getRepository(CausalChainDefinition);
        id = (await repo.save(repo.create({ ...base, ...(e.content as ChainContent), createdBy }))).id;
      }
    }
    for (const r of e.rows) {
      // A conflict is not applied: skipped, saying why, and named in the summary.
      if (e.action === 'conflict') {
        r.status = 'skipped';
        r.message = `Not written: "${e.slug}" already has a draft (v${e.version}), which may hold an author's edits. Publish or discard it, then upload again.`;
        continue;
      }
      r.status = 'applied';
      if (id) r.targetRef = id;
    }
  }
  return summarizeRulePlan(plan);
}
