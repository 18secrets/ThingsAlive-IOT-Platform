/**
 * The closed widget vocabulary (task QREC0b) — the same shape as
 * `TENANT_ASSIGNABLE_PAGES`: a const array and the union it defines.
 *
 * A widget *type* is TypeScript and a deploy; a widget *instance and its position*
 * are rows and content. Getting that backwards means a new equipment class needs a
 * frontend release — the mistake `buildEquipmentModel(category)` made in the demo.
 * Adding a type here needs a renderer, so it needs a deploy, and the CHECK constraint
 * in the layout migration is changed in that same deploy (test/page-layout.spec.ts
 * fails if the two drift apart).
 */
export const WIDGET_TYPES = [
  'kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'readiness_list', 'schematic',
  'alert_list', 'work_order_list', 'service_due', 'failure_modes', 'recommendations', 'machine_list',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_SIZES = ['small', 'medium', 'large', 'full'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Which page a widget belongs on. An equipment page and a site page share the
 * vocabulary but not every word in it: a site has no declared signals of its own,
 * and a machine has no member machines to list. */
export type LayoutScope = 'equipment' | 'site';

export interface WidgetSpec {
  /** What `bound_to` names — a class formula, a declared signal, or nothing. */
  binds: 'formula' | 'signal' | 'none';
  scopes: readonly LayoutScope[];
}

export const WIDGET_SPECS: Readonly<Record<WidgetType, WidgetSpec>> = Object.freeze({
  kpi_number: { binds: 'formula', scopes: ['equipment', 'site'] },
  kpi_gauge: { binds: 'formula', scopes: ['equipment', 'site'] },
  kpi_chart: { binds: 'formula', scopes: ['equipment', 'site'] },
  signal_chart: { binds: 'signal', scopes: ['equipment'] },
  readiness_list: { binds: 'none', scopes: ['equipment'] },
  // QREC0c supplies the asset; this only declares the slot.
  schematic: { binds: 'none', scopes: ['equipment'] },
  alert_list: { binds: 'none', scopes: ['equipment', 'site'] },
  work_order_list: { binds: 'none', scopes: ['equipment', 'site'] },
  service_due: { binds: 'none', scopes: ['equipment'] },
  // Read QREC0a's equipment_class_failure_mode / _recommendation.
  failure_modes: { binds: 'none', scopes: ['equipment'] },
  recommendations: { binds: 'none', scopes: ['equipment'] },
  machine_list: { binds: 'none', scopes: ['site'] },
});

export const isWidgetType = (v: string): v is WidgetType => (WIDGET_TYPES as readonly string[]).includes(v);
