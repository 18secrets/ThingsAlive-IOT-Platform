import { FormulaChartType, FormulaResultKind } from '../entities/equipment-class-formula.entity';
import { isWidgetType, LayoutScope, WIDGET_SIZES, WIDGET_SPECS, WidgetType } from './widget-types';

export interface LayoutWidget {
  widgetType: string;
  widgetKey: string;
  boundTo: string | null;
  title: string | null;
  position: number;
  size: string;
}

/** What a formula says about how it is shown — all the layout needs to agree with it. */
export interface FormulaPresentation {
  formulaKey: string;
  chartType: FormulaChartType;
  resultKind: FormulaResultKind | null;
  /** A target value, or a band with both bounds. */
  hasTarget: boolean;
}

export interface LayoutContext {
  scope: LayoutScope;
  formulas: FormulaPresentation[];
  signals: string[];
}

/**
 * Which widget a formula may be shown in (task QREC0b, decided 2026-10-05).
 *
 * The formula is the one place presentation is decided: QREC0a lets an author say
 * "this series displays as a number, showing the latest point", and a layout that
 * then charts it would contradict them. `chart_type` is the authority; only when it
 * is `'none'` — the column's default, meaning nobody declared one — does the compiled
 * `result_kind` decide.
 */
export function widgetsAccepting(f: FormulaPresentation): WidgetType[] {
  switch (f.chartType) {
    case 'number': return ['kpi_number'];
    case 'gauge': return ['kpi_gauge'];
    case 'line': case 'bar': case 'area': return ['kpi_chart'];
    case 'none':
    default:
      if (f.resultKind === 'series') return ['kpi_chart'];
      if (f.resultKind === 'scalar') return f.hasTarget ? ['kpi_number', 'kpi_gauge'] : ['kpi_number'];
      return [];
  }
}

/**
 * Every reason a layout cannot publish, each naming what and where. Content that
 * references something absent is a defect, not a draft.
 */
export function layoutProblems(widgets: LayoutWidget[], ctx: LayoutContext): string[] {
  const problems: string[] = [];
  const formulas = new Map(ctx.formulas.map((f) => [f.formulaKey, f]));
  const signals = new Set(ctx.signals);
  const seenKeys = new Map<string, number>();
  const seenPositions = new Map<number, string>();

  for (const w of widgets) {
    const at = `widget "${w.widgetKey}"`;
    if (seenKeys.has(w.widgetKey)) problems.push(`${at} appears more than once.`);
    seenKeys.set(w.widgetKey, w.position);
    const other = seenPositions.get(w.position);
    if (other !== undefined) problems.push(`${at} and widget "${other}" are both at position ${w.position}.`);
    else seenPositions.set(w.position, w.widgetKey);
    if (!(WIDGET_SIZES as readonly string[]).includes(w.size)) {
      problems.push(`${at} has size "${w.size}", which is not one of ${WIDGET_SIZES.join(', ')}.`);
    }

    if (!isWidgetType(w.widgetType)) {
      problems.push(`${at} has widget type "${w.widgetType}", which is not in the widget vocabulary.`);
      continue;
    }
    const spec = WIDGET_SPECS[w.widgetType];
    if (!spec.scopes.includes(ctx.scope)) {
      problems.push(`${at}: "${w.widgetType}" has no meaning on ${ctx.scope === 'equipment' ? 'an equipment' : 'a site'} page.`);
      continue;
    }

    if (spec.binds === 'none') {
      if (w.boundTo) problems.push(`${at}: "${w.widgetType}" binds to nothing, but bound_to is "${w.boundTo}".`);
      continue;
    }
    if (!w.boundTo) {
      problems.push(`${at}: "${w.widgetType}" must be bound to a ${spec.binds}, and bound_to is blank.`);
      continue;
    }

    if (spec.binds === 'signal') {
      if (!signals.has(w.boundTo)) problems.push(`${at} is bound to signal "${w.boundTo}", which the class does not declare.`);
      continue;
    }

    const f = formulas.get(w.boundTo);
    if (!f) {
      problems.push(`${at} is bound to formula "${w.boundTo}", which the class does not declare.`);
      continue;
    }
    if (w.widgetType === 'kpi_gauge' && !f.hasTarget) {
      problems.push(`${at}: a gauge needs a target, and formula "${w.boundTo}" has no target_value or band.`);
      continue;
    }
    const accepted = widgetsAccepting(f);
    if (!accepted.includes(w.widgetType)) {
      problems.push(
        `${at}: "${w.widgetType}" contradicts formula "${w.boundTo}" (chart_type "${f.chartType}", `
          + `result_kind "${f.resultKind ?? 'unknown'}"), which displays as ${accepted.join(' or ') || 'nothing yet'}.`,
      );
    }
  }
  return problems;
}

/**
 * The page a class with no layout rows gets — computed, never stored (task QREC0b
 * §2). Publishing is never gated on authoring a layout; library growth would stall
 * behind page design. A readiness list, then every formula in the widget its own
 * presentation asks for, ordered by formula key.
 *
 * A formula whose chart_type is "gauge" but which has no target cannot be a gauge;
 * it falls back to kpi_number rather than vanishing from the page.
 */
export function fallbackLayout(formulas: FormulaPresentation[]): LayoutWidget[] {
  const widgets: LayoutWidget[] = [{
    widgetType: 'readiness_list', widgetKey: 'readiness', boundTo: null, title: null, position: 1, size: 'full',
  }];
  const sorted = [...formulas].sort((a, b) => a.formulaKey.localeCompare(b.formulaKey));
  for (const f of sorted) {
    const accepted = widgetsAccepting(f);
    const type: WidgetType = accepted.includes('kpi_chart') ? 'kpi_chart'
      : accepted.includes('kpi_gauge') && f.chartType === 'gauge' ? 'kpi_gauge'
        : 'kpi_number';
    widgets.push({
      widgetType: type, widgetKey: f.formulaKey, boundTo: f.formulaKey, title: null,
      position: widgets.length + 1, size: type === 'kpi_chart' ? 'large' : 'small',
    });
  }
  return widgets;
}

export interface TenantLayoutWidget extends LayoutWidget {
  hidden: boolean;
  /** True once the tenant has moved it — a deliberate change, never silently reverted. */
  positionCustom: boolean;
}

/**
 * A tenant's layout copy, carried onto a new class version (task QREC0b §4) — a pure
 * function, so the rule can be tested on its own rather than only from inside an
 * upgrade path that does not exist yet (QUPGRADE1 will call this).
 *
 *  - class-origin fields (type, binding, title, size) come from the new version;
 *  - a widget the tenant hid stays hidden;
 *  - a widget the tenant moved keeps its position and stays marked custom;
 *  - everything else takes the new version's position, shifted past any position a
 *    custom widget already holds — a deliberate change wins a collision;
 *  - a widget the new version no longer has is dropped: there is nothing left for it
 *    to be bound to.
 */
export function mergeTenantLayout(copy: TenantLayoutWidget[], next: LayoutWidget[]): TenantLayoutWidget[] {
  const byKey = new Map(copy.map((w) => [w.widgetKey, w]));
  const merged: TenantLayoutWidget[] = next.map((w) => {
    const prior = byKey.get(w.widgetKey);
    return {
      ...w,
      hidden: prior?.hidden ?? false,
      positionCustom: prior?.positionCustom ?? false,
      position: prior?.positionCustom ? prior.position : w.position,
    };
  });

  const taken = new Set(merged.filter((w) => w.positionCustom).map((w) => w.position));
  const movable = merged.filter((w) => !w.positionCustom).sort((a, b) => a.position - b.position);
  for (const w of movable) {
    let p = w.position;
    while (taken.has(p)) p += 1;
    w.position = p;
    taken.add(p);
  }
  return merged.sort((a, b) => a.position - b.position);
}
