import { EntityManager } from 'typeorm';
import { Plant } from '../../equipment/entities/plant.entity';
import { EquipmentClassFormula } from '../entities/equipment-class-formula.entity';
import { EquipmentClassLayout } from '../entities/equipment-class-layout.entity';
import { DEFAULT_SITE_CLASS_SLUG, SiteClass, SiteClassLayout } from '../entities/site-class.entity';
import { FormulaPresentation, LayoutWidget, layoutProblems } from '../layout/layout-rules';
import { WidgetSize, WidgetType } from '../layout/widget-types';

type Provenance = { source: 'manual' | 'excel-import'; importBatchId: string | null };

/**
 * Page layout for one class version, read and written in one place (task QREC0b) —
 * the same reason class-failure-modes.ts exists: the importer, authoring's fork and
 * copy-on-grant each need it, and three copies of the repository code are three
 * chances to forget a column.
 */
export async function loadLayout(m: EntityManager, classSlug: string, classVersion: number): Promise<LayoutWidget[]> {
  const rows = await m.getRepository(EquipmentClassLayout).find({
    where: { classSlug, classVersion }, order: { position: 'ASC' },
  });
  return rows.map(toWidget);
}

export async function insertLayout(
  m: EntityManager, classSlug: string, classVersion: number, widgets: LayoutWidget[], provenance: Provenance,
): Promise<void> {
  if (!widgets.length) return;
  const repo = m.getRepository(EquipmentClassLayout);
  await repo.save(widgets.map((w) => repo.create({
    classSlug, classVersion, ...w,
    widgetType: w.widgetType as WidgetType, size: w.size as WidgetSize, ...provenance,
  })));
}

/** A fork starts with the layout of the version it came from. */
export async function copyLayout(m: EntityManager, classSlug: string, fromVersion: number, toVersion: number) {
  await insertLayout(m, classSlug, toVersion, await loadLayout(m, classSlug, fromVersion), {
    source: 'manual', importBatchId: null,
  });
}

/** How each of a version's formulas asks to be shown — what a layout must agree with. */
export async function formulaPresentations(
  m: EntityManager, classSlug: string, classVersion: number,
): Promise<FormulaPresentation[]> {
  const rows = await m.getRepository(EquipmentClassFormula).find({ where: { classSlug, classVersion } });
  return rows.map(presentationOf);
}

export function presentationOf(f: Pick<EquipmentClassFormula,
  'formulaKey' | 'chartType' | 'resultKind' | 'targetValue' | 'targetMin' | 'targetMax'>): FormulaPresentation {
  return {
    formulaKey: f.formulaKey,
    chartType: f.chartType,
    resultKind: f.resultKind,
    hasTarget: f.targetValue != null || (f.targetMin != null && f.targetMax != null),
  };
}

/**
 * Which site class a plant's page is. NULL on the plant means the platform default —
 * its latest published version — never "no page".
 */
export async function resolveSiteClass(
  m: EntityManager, plant: Pick<Plant, 'siteClassSlug' | 'siteClassVersion'>,
): Promise<SiteClass> {
  if (plant.siteClassSlug && plant.siteClassVersion != null) {
    return m.getRepository(SiteClass).findOneByOrFail({ slug: plant.siteClassSlug, version: plant.siteClassVersion });
  }
  const [latest] = await m.getRepository(SiteClass).find({
    where: { slug: DEFAULT_SITE_CLASS_SLUG, status: 'published' }, order: { version: 'DESC' }, take: 1,
  });
  if (!latest) throw new Error(`No published "${DEFAULT_SITE_CLASS_SLUG}" site class — the migration seeds one.`);
  return latest;
}

export async function siteLayout(m: EntityManager, site: Pick<SiteClass, 'slug' | 'version'>): Promise<LayoutWidget[]> {
  const rows = await m.getRepository(SiteClassLayout).find({
    where: { siteClassSlug: site.slug, classVersion: site.version }, order: { position: 'ASC' },
  });
  return rows.map(toWidget);
}

/** A site page is checked against the same vocabulary, in site scope. A site class
 * declares no formulas or signals of its own (aggregation is QPAGE1's), so any
 * binding widget on one is refused as unbound for now. */
export const siteLayoutProblems = (widgets: LayoutWidget[]): string[] =>
  layoutProblems(widgets, { scope: 'site', formulas: [], signals: [] });

const toWidget = (r: Pick<EquipmentClassLayout,
  'widgetType' | 'widgetKey' | 'boundTo' | 'title' | 'position' | 'size'>): LayoutWidget => ({
  widgetType: r.widgetType, widgetKey: r.widgetKey, boundTo: r.boundTo, title: r.title,
  position: r.position, size: r.size,
});
