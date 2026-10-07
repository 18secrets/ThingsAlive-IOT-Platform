import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassFailureMode } from '../../catalog/entities/equipment-class-failure-mode.entity';
import { EquipmentClassFormula } from '../../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { EquipmentClassRecommendation } from '../../catalog/entities/equipment-class-recommendation.entity';
import { WidgetSize, WidgetType } from '../../catalog/layout/widget-types';
import { LayoutWidget, mergeTenantLayout } from '../../catalog/layout/layout-rules';
import { loadLayout } from '../../catalog/services/class-layout';
import { toFailureModeJsonb } from '../../catalog/services/class-failure-modes';
import { loadAnchors, loadVisual } from '../../catalog/services/class-visual.service';
import { Anchor, mergeTenantAnchors } from '../../catalog/visual/anchor-rules';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientEquipmentClassFailureMode } from '../entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassLayout } from '../entities/client-equipment-class-layout.entity';
import { ClientEquipmentClassRecommendation } from '../entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClassVisualAnchor } from '../entities/client-equipment-class-visual-anchor.entity';
import { ClientFormula } from '../entities/client-formula.entity';
import { ContentKind, PlannedChange, planUpgrade, same } from './class-upgrade-plan';
import { classContentChecksum } from './provenance';

type Formula = EquipmentClassFormula | ClientFormula;
type Mode = EquipmentClassFailureMode | ClientEquipmentClassFailureMode;
type Rec = EquipmentClassRecommendation | ClientEquipmentClassRecommendation;

const FORMULA: ContentKind<Formula> = {
  key: (f) => f.formulaKey,
  content: (f) => ({
    kind: f.kind, expression: f.expression, namedFormulaSlug: f.namedFormulaSlug, bindings: f.bindings,
    displayUnit: f.displayUnit, displayFormat: f.displayFormat, targetValue: f.targetValue, targetMin: f.targetMin,
    targetMax: f.targetMax, targetDirection: f.targetDirection, comparisonBasis: f.comparisonBasis,
    aggregationWindow: f.aggregationWindow, chartType: f.chartType,
  }),
};
const MODE: ContentKind<Mode> = {
  key: (f) => f.code,
  content: (f) => ({ name: f.name, symptom: f.symptom, severity: f.severity, signals: f.signals }),
};
/** No natural key exists for a recommendation, so it is its failure mode plus its
 * action text: rewriting the action makes a tenant-added one and orphans the original
 * — honest, and nothing is lost. */
const REC: ContentKind<Rec> = {
  key: (r) => `${r.failureModeCode}::${r.action}`,
  content: (r) => ({ urgency: r.urgency, estimatedHours: r.estimatedHours, requiredParts: r.requiredParts }),
};
const CLASS_FIELDS = (c: { name: string; description: string | null; category: string | null; defaultThresholds: unknown }) => ({
  name: c.name, description: c.description, category: c.category, defaultThresholds: c.defaultThresholds,
});

type Summary = Omit<PlannedChange<unknown>, 'next'>;

export interface UpgradePreview {
  slug: string;
  fromVersion: number;
  toVersion: number;
  upToDate: boolean;
  classFields: { origin: 'inherited' | 'customised'; action: 'replace' | 'keep' };
  formulas: Summary[];
  failureModes: Summary[];
  recommendations: Summary[];
  layout: { added: string[]; removed: string[]; keptCustom: string[] };
  anchors: { added: string[]; removed: string[]; keptCustom: string[]; needsRecheck: string[] };
}

export interface UpgradeResult extends UpgradePreview {
  upgraded: boolean;
}

interface Loaded {
  cls: ClientEquipmentClass;
  from: number;
  base: Map<number, { profile: EquipmentClassProfile; formulas: EquipmentClassFormula[]; modes: EquipmentClassFailureMode[]; recs: EquipmentClassRecommendation[] }>;
  next: { profile: EquipmentClassProfile; formulas: EquipmentClassFormula[]; modes: EquipmentClassFailureMode[]; recs: EquipmentClassRecommendation[] };
  formulas: ClientFormula[];
  modes: ClientEquipmentClassFailureMode[];
  recs: ClientEquipmentClassRecommendation[];
  layout: ClientEquipmentClassLayout[];
  anchors: ClientEquipmentClassVisualAnchor[];
  nextLayout: LayoutWidget[];
  nextAnchors: Anchor[];
  /** No `geometry_version` exists: a different schematic image between the two
   * versions is the geometry change (QUPGRADE1 §3). */
  geometryChanged: boolean;
}

/**
 * Upgrading a tenant's copy of a class to a newer published version (task QUPGRADE1).
 *
 * Covers the content pinned to (class_slug, class_version): the class row, formulas,
 * failure modes, recommendations, layout and anchors. Scenarios and alert rules
 * version on their own and keep their per-item adopt path.
 */
@Injectable()
export class ClassUpgradeService {
  private readonly logger = new Logger(ClassUpgradeService.name);

  constructor(private readonly ds: DataSource) {}

  async preview(scope: RequestScope, slug: string): Promise<UpgradePreview> {
    const toVersion = await this.latestPublished(slug);
    return withTenantSession(this.ds, scope, async (m) => this.describe(await this.load(m, scope.tenantId, slug, toVersion)));
  }

  /**
   * Applies the upgrade the tenant saw. `toVersion` must still be the latest published:
   * applying a diff nobody read is the failure this endpoint exists to prevent.
   * Idempotent under a per-(tenant, class) lock — the copy's version is re-read inside it.
   */
  async apply(scope: RequestScope, slug: string, toVersion: number, now = new Date()): Promise<UpgradeResult> {
    const latest = await this.latestPublished(slug);
    if (toVersion !== latest) {
      throw new ConflictException(
        `"${slug}" v${latest} is the latest published version, not v${toVersion}. Review the upgrade again before applying it.`,
      );
    }
    return withTenantSession(this.ds, scope, async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('class-upgrade:' || $1 || ':' || $2))`, [scope.tenantId, slug]);
      const loaded = await this.load(m, scope.tenantId, slug, toVersion);
      const plan = this.describe(loaded);
      if (plan.upToDate) return { ...plan, upgraded: false };
      await this.write(m, scope, loaded, now);
      this.logger.log(`${scope.userId} upgraded "${slug}" from v${loaded.from} to v${toVersion} in tenant ${scope.tenantId}.`);
      return { ...plan, upgraded: true };
    });
  }

  // --------------------------------------------------------------------------------

  private async latestPublished(slug: string): Promise<number> {
    const [row] = await this.ds.getRepository(EquipmentClassProfile).find({
      where: { slug, status: 'published' }, order: { version: 'DESC' }, take: 1,
    });
    if (!row) throw new NotFoundException(`No published "${slug}" to upgrade to.`);
    return row.version;
  }

  /** Template rows are platform-owned and read outside the tenant session, the same way
   * copy-on-grant reads them; the tenant's rows are read inside it. */
  private async load(m: EntityManager, tenantId: string, slug: string, toVersion: number): Promise<Loaded> {
    const cls = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId, slug } });
    if (!cls) throw new NotFoundException(`This account does not hold "${slug}".`);
    const from = cls.templateVersion ?? 0;
    const where = { tenantId, clientEquipmentClassSlug: slug };
    const [formulas, modes, recs, layout, anchors] = await Promise.all([
      m.getRepository(ClientFormula).find({ where }),
      m.getRepository(ClientEquipmentClassFailureMode).find({ where }),
      m.getRepository(ClientEquipmentClassRecommendation).find({ where }),
      m.getRepository(ClientEquipmentClassLayout).find({ where, order: { position: 'ASC' } }),
      m.getRepository(ClientEquipmentClassVisualAnchor).find({ where }),
    ]);
    const versions = new Set<number>([from]);
    for (const r of [...formulas, ...modes, ...recs]) if (r.templateVersion != null) versions.add(r.templateVersion);
    const base = new Map<number, Loaded['base'] extends Map<number, infer V> ? V : never>();
    for (const v of versions) base.set(v, await this.template(slug, v));
    const pm = this.ds.manager;
    const [nextLayout, nextAnchors, oldVisual, newVisual] = await Promise.all([
      loadLayout(pm, slug, toVersion), loadAnchors(pm, slug, toVersion), loadVisual(pm, slug, from), loadVisual(pm, slug, toVersion),
    ]);
    return {
      cls, from, base, next: await this.template(slug, toVersion), formulas, modes, recs, layout, anchors,
      nextLayout, nextAnchors, geometryChanged: (oldVisual?.assetKey ?? null) !== (newVisual?.assetKey ?? null),
    };
  }

  private async template(slug: string, version: number) {
    const m = this.ds.manager;
    const where = { classSlug: slug, classVersion: version };
    const [profile, formulas, modes, recs] = await Promise.all([
      m.getRepository(EquipmentClassProfile).findOne({ where: { slug, version } }),
      m.getRepository(EquipmentClassFormula).find({ where }),
      m.getRepository(EquipmentClassFailureMode).find({ where }),
      m.getRepository(EquipmentClassRecommendation).find({ where }),
    ]);
    return { profile: profile!, formulas, modes, recs };
  }

  private plans(l: Loaded) {
    const baseOf = <T>(pick: (b: NonNullable<ReturnType<Loaded['base']['get']>>) => T[], kind: ContentKind<T>) =>
      (row: { templateVersion: number | null }, key: string) => {
        const b = l.base.get(row.templateVersion ?? l.from);
        return b ? pick(b).find((t) => kind.key(t) === key) : undefined;
      };
    const fBase = baseOf((b) => b.formulas, FORMULA as ContentKind<EquipmentClassFormula>);
    const mBase = baseOf((b) => b.modes, MODE as ContentKind<EquipmentClassFailureMode>);
    const rBase = baseOf((b) => b.recs, REC as ContentKind<EquipmentClassRecommendation>);
    return {
      formulas: planUpgrade<ClientFormula, EquipmentClassFormula>(
        l.formulas, (r) => fBase(r, FORMULA.key(r)), l.next.formulas, FORMULA, FORMULA),
      modes: planUpgrade<ClientEquipmentClassFailureMode, EquipmentClassFailureMode>(
        l.modes, (r) => mBase(r, MODE.key(r)), l.next.modes, MODE, MODE),
      recs: planUpgrade<ClientEquipmentClassRecommendation, EquipmentClassRecommendation>(
        l.recs, (r) => rBase(r, REC.key(r)), l.next.recs, REC, REC),
    };
  }

  private describe(l: Loaded): UpgradePreview {
    const toVersion = l.next.profile.version;
    const p = this.plans(l);
    const strip = (c: PlannedChange<unknown>): Summary => ({ key: c.key, origin: c.origin, upstream: c.upstream, action: c.action });
    const classCustomised = !same(CLASS_FIELDS(l.cls), CLASS_FIELDS(l.base.get(l.from)!.profile));
    const tenantWidgets = new Set(l.layout.map((w) => w.widgetKey));
    const nextWidgets = new Set(l.nextLayout.map((w) => w.widgetKey));
    const tenantSignals = new Set(l.anchors.map((a) => a.signal));
    const nextSignals = new Set(l.nextAnchors.map((a) => a.signal));
    const custom = l.anchors.filter((a) => a.placementCustom).map((a) => a.signal);
    return {
      slug: l.cls.slug,
      fromVersion: l.from,
      toVersion,
      upToDate: l.from >= toVersion,
      classFields: { origin: classCustomised ? 'customised' : 'inherited', action: classCustomised ? 'keep' : 'replace' },
      formulas: p.formulas.map(strip),
      failureModes: p.modes.map(strip),
      recommendations: p.recs.map(strip),
      // The QREC0b merge: a widget the new version drops goes — nothing is left to bind it to.
      layout: {
        added: [...nextWidgets].filter((k) => !tenantWidgets.has(k)),
        removed: [...tenantWidgets].filter((k) => !nextWidgets.has(k)),
        keptCustom: l.layout.filter((w) => (w.positionCustom || w.hidden) && nextWidgets.has(w.widgetKey)).map((w) => w.widgetKey),
      },
      // The QREC0c merge: a tenant-placed anchor always stays; a class one follows the version.
      anchors: {
        added: [...nextSignals].filter((sig) => !tenantSignals.has(sig)),
        removed: l.anchors.filter((a) => !a.placementCustom && !nextSignals.has(a.signal)).map((a) => a.signal),
        keptCustom: custom,
        needsRecheck: l.geometryChanged ? custom : [],
      },
    };
  }

  private async write(m: EntityManager, scope: RequestScope, l: Loaded, now: Date): Promise<void> {
    const to = l.next.profile.version;
    const tenantId = scope.tenantId;
    const slug = l.cls.slug;
    const p = this.plans(l);

    // Failure modes before recommendations: the tenant copy carries the same foreign key.
    await this.applyPlan(m, p.modes, l.modes, MODE, ClientEquipmentClassFailureMode, (t) => ({
      tenantId, clientEquipmentClassSlug: slug, code: t.code, name: t.name, symptom: t.symptom,
      severity: t.severity, signals: t.signals, templateVersion: to, copiedAt: now, orphanedAt: null,
    }), now);
    await this.applyPlan(m, p.recs, l.recs, REC, ClientEquipmentClassRecommendation, (t) => ({
      tenantId, clientEquipmentClassSlug: slug, failureModeCode: t.failureModeCode, action: t.action,
      urgency: t.urgency, estimatedHours: t.estimatedHours, requiredParts: t.requiredParts,
      templateVersion: to, copiedAt: now, orphanedAt: null,
    }), now);
    await this.applyPlan(m, p.formulas, l.formulas, FORMULA, ClientFormula, (t) => ({
      tenantId, clientEquipmentClassSlug: slug, formulaKey: t.formulaKey, kind: t.kind, expression: t.expression,
      compiledPlan: t.compiledPlan, compiledAt: t.compiledAt, compilerVersion: t.compilerVersion, resultUnit: t.resultUnit,
      requiredSignals: t.requiredSignals, requiredParameters: t.requiredParameters, namedFormulaSlug: t.namedFormulaSlug,
      namedFormulaVersion: t.namedFormulaVersion, bindings: t.bindings, resultKind: t.resultKind, displayUnit: t.displayUnit,
      displayFormat: t.displayFormat, targetValue: t.targetValue, targetMin: t.targetMin, targetMax: t.targetMax,
      targetDirection: t.targetDirection, comparisonBasis: t.comparisonBasis, aggregationWindow: t.aggregationWindow,
      chartType: t.chartType, templateVersion: to, copiedAt: now, orphanedAt: null, status: 'active' as const, updatedBy: scope.userId,
    }), now);

    // Layout and anchors: the merges QREC0b and QREC0c decided, applied whole.
    const layoutRepo = m.getRepository(ClientEquipmentClassLayout);
    const mergedLayout = mergeTenantLayout(
      l.layout.map((w) => ({ widgetType: w.widgetType, widgetKey: w.widgetKey, boundTo: w.boundTo, title: w.title,
        position: w.position, size: w.size, hidden: w.hidden, positionCustom: w.positionCustom })),
      l.nextLayout,
    );
    await layoutRepo.delete({ tenantId, clientEquipmentClassSlug: slug });
    if (mergedLayout.length) {
      await layoutRepo.save(mergedLayout.map((w) => layoutRepo.create({
        tenantId, clientEquipmentClassSlug: slug, ...w, widgetType: w.widgetType as WidgetType, size: w.size as WidgetSize,
        templateVersion: to, copiedAt: now,
      })));
    }

    const anchorRepo = m.getRepository(ClientEquipmentClassVisualAnchor);
    const mergedAnchors = mergeTenantAnchors(
      l.anchors.map((a) => ({ signal: a.signal, hotspotX: a.hotspotX, hotspotY: a.hotspotY, label: a.label, placementCustom: a.placementCustom })),
      l.nextAnchors,
    );
    const recheckBefore = new Map(l.anchors.map((a) => [a.signal, a.needsRecheck]));
    await anchorRepo.delete({ tenantId, clientEquipmentClassSlug: slug });
    if (mergedAnchors.length) {
      await anchorRepo.save(mergedAnchors.map((a) => anchorRepo.create({
        tenantId, clientEquipmentClassSlug: slug, ...a,
        // A hand-placed marker on a picture that changed may now point at the wrong part.
        needsRecheck: a.placementCustom && (l.geometryChanged || (recheckBefore.get(a.signal) ?? false)),
        templateVersion: to, copiedAt: now,
      })));
    }

    // The class row last: it is what says which version the copy now tracks.
    const classCustomised = !same(CLASS_FIELDS(l.cls), CLASS_FIELDS(l.base.get(l.from)!.profile));
    const finalModes = await m.getRepository(ClientEquipmentClassFailureMode).find({
      where: { tenantId, clientEquipmentClassSlug: slug }, order: { code: 'ASC' },
    });
    const next = l.next.profile;
    if (!classCustomised) Object.assign(l.cls, CLASS_FIELDS(next));
    l.cls.expectedSignals = next.expectedSignals;
    l.cls.failureModes = toFailureModeJsonb(finalModes);
    l.cls.templateVersion = to;
    l.cls.templateChecksum = classContentChecksum({ ...next, failureModes: l.cls.failureModes });
    l.cls.updatedBy = scope.userId;
    await m.getRepository(ClientEquipmentClass).save(l.cls);
  }

  private async applyPlan<T extends { id: string; orphanedAt: Date | null }, Tpl>(
    m: EntityManager, plan: PlannedChange<Tpl>[], rows: T[], kind: ContentKind<any>,
    entity: new () => T, fromTemplate: (t: Tpl) => Partial<T>, now: Date,
  ): Promise<void> {
    const repo = m.getRepository<T>(entity);
    const byKey = new Map(rows.map((r) => [kind.key(r), r]));
    for (const c of plan) {
      const row = byKey.get(c.key);
      if (c.action === 'add') await repo.save(repo.create(fromTemplate(c.next!) as T));
      if (c.action === 'replace' && row) await repo.save(Object.assign(row, fromTemplate(c.next!)));
      if (c.action === 'orphan' && row && !row.orphanedAt) await repo.save(Object.assign(row, { orphanedAt: now }));
    }
  }
}
