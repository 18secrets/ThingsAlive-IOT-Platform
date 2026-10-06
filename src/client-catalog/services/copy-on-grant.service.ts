import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentClassFormula } from '../../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../../catalog/entities/scenario-definition.entity';
import { AlertRuleTemplate } from '../../catalog/entities/alert-rule-template.entity';
import { AlertRule } from '../../alert/entities/alert-rule.entity';
import { withTenantId } from '../../scope/tenant-session';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientFormula } from '../entities/client-formula.entity';
import { ClientScenario } from '../entities/client-scenario.entity';
import { ClientEquipmentClassFailureMode } from '../entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../entities/client-equipment-class-recommendation.entity';
import { ClientEquipmentClassLayout } from '../entities/client-equipment-class-layout.entity';
import { loadLayout } from '../../catalog/services/class-layout';
import { loadAnchors } from '../../catalog/services/class-visual.service';
import { ClientEquipmentClassVisualAnchor } from '../entities/client-equipment-class-visual-anchor.entity';
import { WidgetSize, WidgetType } from '../../catalog/layout/widget-types';
import {
  loadFailureModes, loadRecommendations, toFailureModeJsonb,
} from '../../catalog/services/class-failure-modes';
import { alertRuleContentChecksum, classContentChecksum, scenarioContentChecksum } from './provenance';

export interface CopyResult {
  classSlug: string;
  templateVersion: number;
  scenariosCopied: number;
  alertRulesCopied: number;
  formulasCopied: number;
  failureModesCopied: number;
  recommendationsCopied: number;
  layoutWidgetsCopied: number;
  anchorsCopied: number;
  alreadyPresent: boolean;
}

/**
 * Turns a grant into the client's own copy of a class and its scenarios.
 *
 * This is the moment ownership transfers. Before it, the class is a Things Alive
 * template; after it, the rows belong to the client and Things Alive cannot write
 * them. The copy runs inside that tenant's own row-level-security session, so it is
 * physically incapable of writing into the wrong account even if the tenant id were
 * wrong — which is a better guarantee than remembering to pass it correctly.
 */
@Injectable()
export class CopyOnGrantService {
  private readonly logger = new Logger(CopyOnGrantService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Copies the latest published version of a class, with its published scenarios.
   *
   * **Never overwrites an existing copy.** If the client already has this class, the
   * copy is theirs and may have been edited; silently replacing it would be Things
   * Alive editing a client's settings through the side door. Re-granting a class the
   * client already has is a no-op that says so.
   */
  async copyForTenant(
    tenantId: string,
    templateSlug: string,
    copiedBy: string,
    now = new Date(),
  ): Promise<CopyResult> {
    const template = await this.latestPublishedClass(templateSlug);
    if (!template) {
      throw new Error(`No published template "${templateSlug}" to copy.`);
    }

    const scenarios = await this.latestPublishedScenarios(templateSlug);
    const alertTemplates = await this.latestPublishedAlertTemplates(templateSlug);
    const formulas = await this.latestPublishedFormulas(templateSlug, template.version);
    // Rows, never the deprecated jsonb (task QREC0a) — the same version being granted.
    const failureModes = await loadFailureModes(this.ds.manager, templateSlug, template.version);
    const recommendations = await loadRecommendations(this.ds.manager, templateSlug, template.version);
    const layout = await loadLayout(this.ds.manager, templateSlug, template.version);
    const anchors = await loadAnchors(this.ds.manager, templateSlug, template.version);

    return withTenantId(this.ds, tenantId, async (m: EntityManager) => {
      const classes = m.getRepository(ClientEquipmentClass);
      const existing = await classes.findOne({ where: { tenantId, slug: template.slug } });
      if (existing) {
        // Task QGRANT0 §4: re-grant was previously a silent no-op regardless of
        // which version the tenant already held — including this case, where a
        // newer class version has since been published and the tenant's copy is
        // quietly stale. Made explicit: same version is still a no-op; a newer
        // version is refused rather than silently skipped, because upgrading an
        // existing copy (merging what the tenant customised against what changed)
        // is a real feature this is not — that is QUPGRADE1's job.
        if ((existing.templateVersion ?? 0) < template.version) {
          throw new Error(
            `Tenant ${tenantId} holds "${template.slug}" v${existing.templateVersion}, and v${template.version} `
              + 'is now published. Upgrading an existing copy to a newer class version is not built here — '
              + "that is QUPGRADE1's job. Nothing was changed.",
          );
        }
        this.logger.log(
          `Tenant ${tenantId} already has "${template.slug}" v${existing.templateVersion}; leaving their copy alone.`,
        );
        return {
          classSlug: existing.slug,
          templateVersion: existing.templateVersion ?? template.version,
          scenariosCopied: 0,
          alertRulesCopied: 0,
          formulasCopied: 0,
          failureModesCopied: 0,
          recommendationsCopied: 0,
          layoutWidgetsCopied: 0,
          anchorsCopied: 0,
          alreadyPresent: true,
        };
      }

      await classes.save(classes.create({
        tenantId,
        slug: template.slug,
        name: template.name,
        description: template.description,
        category: template.category,
        expectedSignals: template.expectedSignals,
        // Deprecated, still populated (task QREC0a) — from the rows, so the jsonb and
        // client_equipment_class_failure_mode cannot start out disagreeing.
        failureModes: toFailureModeJsonb(failureModes),
        defaultThresholds: template.defaultThresholds,
        templateSlug: template.slug,
        templateVersion: template.version,
        // Hashed over what this copy actually holds, not the template's own jsonb —
        // the rows come back ordered by code, which need not be the jsonb's order,
        // and a checksum taken over one and compared against the other would call
        // every copy edited the moment it was written.
        templateChecksum: classContentChecksum({ ...template, failureModes: toFailureModeJsonb(failureModes) }),
        copiedAt: now,
        status: 'active',
        updatedBy: copiedBy,
      }));

      const clientScenarios = m.getRepository(ClientScenario);
      let copied = 0;
      for (const s of scenarios) {
        const already = await clientScenarios.findOne({ where: { tenantId, slug: s.slug } });
        if (already) continue;
        await clientScenarios.save(clientScenarios.create({
          tenantId,
          slug: s.slug,
          clientEquipmentClassSlug: template.slug,
          name: s.name,
          description: s.description,
          severity: s.severity,
          tier: s.tier,
          requiredSignals: s.requiredSignals,
          minimumHistoryDays: s.minimumHistoryDays,
          parameters: s.parameters,
          enabled: true,
          templateSlug: s.slug,
          templateVersion: s.version,
          templateChecksum: scenarioContentChecksum(s),
          copiedAt: now,
          status: 'active',
          updatedBy: copiedBy,
        }));
        copied += 1;
      }

      // Alert rules, the fourth kind of catalog content (task P1-128). They copy last
      // because a rule can name a scenario, and a rule pointing at a scenario that is
      // not there yet is a rule that looks configured and never fires.
      const rules = m.getRepository(AlertRule);
      let rulesCopied = 0;
      for (const t of alertTemplates) {
        const already = await rules.findOne({ where: { tenantId, slug: t.slug } });
        if (already) continue;
        await rules.save(rules.create({
          tenantId,
          slug: t.slug,
          name: t.name,
          description: t.description,
          trigger: t.trigger,
          params: t.params,
          // Scoped to the class it came from, not to the account. A rule authored about
          // generators watching the account would fire on the air compressors too.
          appliesTo: 'equipment-class',
          equipmentClassSlug: template.slug,
          plantId: null,
          sourceSystem: null,
          externalId: null,
          severity: t.severity,
          enabled: t.enabledOnCopy,
          templateSlug: t.slug,
          templateVersion: t.version,
          templateChecksum: alertRuleContentChecksum({ ...t, enabled: t.enabledOnCopy }),
          copiedAt: now,
          createdBy: copiedBy,
          updatedBy: copiedBy,
        }));
        rulesCopied += 1;
      }

      // Formulas (task QGRANT0) — copied as data, the same way `compiled_plan`
      // already lived on the platform row: nothing here is a reference the
      // tenant could resolve against `named_formula` later. Publishing a new
      // named-formula version changes nothing already copied, for the same
      // reason a template edit does not reach an existing `ClientEquipmentClass`.
      const clientFormulas = m.getRepository(ClientFormula);
      let formulasCopied = 0;
      for (const f of formulas) {
        const already = await clientFormulas.findOne({
          where: { tenantId, clientEquipmentClassSlug: template.slug, formulaKey: f.formulaKey },
        });
        if (already) continue;
        await clientFormulas.save(clientFormulas.create({
          tenantId,
          clientEquipmentClassSlug: template.slug,
          formulaKey: f.formulaKey,
          kind: f.kind,
          expression: f.expression,
          compiledPlan: f.compiledPlan,
          compiledAt: f.compiledAt,
          compilerVersion: f.compilerVersion,
          resultUnit: f.resultUnit,
          requiredSignals: f.requiredSignals,
          requiredParameters: f.requiredParameters,
          namedFormulaSlug: f.namedFormulaSlug,
          namedFormulaVersion: f.namedFormulaVersion,
          bindings: f.bindings,
          resultKind: f.resultKind,
          displayUnit: f.displayUnit,
          displayFormat: f.displayFormat,
          targetValue: f.targetValue,
          targetMin: f.targetMin,
          targetMax: f.targetMax,
          targetDirection: f.targetDirection,
          comparisonBasis: f.comparisonBasis,
          aggregationWindow: f.aggregationWindow,
          chartType: f.chartType,
          templateVersion: template.version,
          copiedAt: now,
          status: 'active',
          updatedBy: copiedBy,
        }));
        formulasCopied += 1;
      }

      // Failure modes, then the recommendations that point at them (task QREC0a) —
      // in that order because the tenant copy carries the same foreign key the
      // platform row does. Copied whole: this branch only runs for a class the
      // tenant did not already hold, so there is no earlier copy to merge with.
      const clientModes = m.getRepository(ClientEquipmentClassFailureMode);
      if (failureModes.length) {
        await clientModes.save(failureModes.map((f) => clientModes.create({
          tenantId, clientEquipmentClassSlug: template.slug, ...f,
          templateVersion: template.version, copiedAt: now,
        })));
      }
      const clientRecommendations = m.getRepository(ClientEquipmentClassRecommendation);
      if (recommendations.length) {
        await clientRecommendations.save(recommendations.map((r) => clientRecommendations.create({
          tenantId, clientEquipmentClassSlug: template.slug, ...r,
          templateVersion: template.version, copiedAt: now,
        })));
      }

      // The page layout (task QREC0b), as the class authored it: nothing hidden, no
      // position customised. A class with no layout copies nothing, and the tenant's
      // page is the same computed fallback the platform's would be.
      const clientLayout = m.getRepository(ClientEquipmentClassLayout);
      if (layout.length) {
        await clientLayout.save(layout.map((w) => clientLayout.create({
          tenantId, clientEquipmentClassSlug: template.slug, ...w,
          widgetType: w.widgetType as WidgetType, size: w.size as WidgetSize,
          hidden: false, positionCustom: false, templateVersion: template.version, copiedAt: now,
        })));
      }

      // The visual's anchors (task QREC0c) — rows, and the tenant's from here on. The
      // image itself is not copied: one object serves every tenant with the class.
      const clientAnchors = m.getRepository(ClientEquipmentClassVisualAnchor);
      if (anchors.length) {
        await clientAnchors.save(anchors.map((a) => clientAnchors.create({
          tenantId, clientEquipmentClassSlug: template.slug, ...a,
          placementCustom: false, templateVersion: template.version, copiedAt: now,
        })));
      }

      this.logger.log(
        `Copied "${template.slug}" v${template.version}, ${copied} scenario(s), `
        + `${rulesCopied} alert rule(s), ${formulasCopied} formula(s), ${failureModes.length} failure mode(s) `
        + `and ${recommendations.length} recommendation(s) to tenant ${tenantId}.`,
      );
      return {
        classSlug: template.slug,
        templateVersion: template.version,
        scenariosCopied: copied,
        alertRulesCopied: rulesCopied,
        formulasCopied,
        failureModesCopied: failureModes.length,
        recommendationsCopied: recommendations.length,
        layoutWidgetsCopied: layout.length,
        anchorsCopied: anchors.length,
        alreadyPresent: false,
      };
    });
  }

  /** The template side of the read. Platform-owned, so no tenant session needed. */
  private async latestPublishedClass(slug: string): Promise<EquipmentClassProfile | null> {
    const rows = await this.ds.getRepository(EquipmentClassProfile).find({
      where: { slug, status: 'published' },
      order: { version: 'DESC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  private async latestPublishedScenarios(classSlug: string): Promise<ScenarioDefinition[]> {
    const rows = await this.ds.getRepository(ScenarioDefinition).find({
      where: { equipmentClassSlug: classSlug, status: 'published' },
      order: { slug: 'ASC', version: 'DESC' },
    });
    const latest = new Map<string, ScenarioDefinition>();
    for (const row of rows) {
      const seen = latest.get(row.slug);
      if (!seen || row.version > seen.version) latest.set(row.slug, row);
    }
    return [...latest.values()];
  }

  /** Formulas belong to one specific (class_slug, class_version), unlike
   * scenarios and alert templates which version independently — so this takes
   * the exact version being granted, not "latest published" of its own. Only
   * those the compiler actually produced a plan for: every formula under a
   * published class version was compiled at that class's own publish, so this
   * is a safety net, not a filter expected to exclude anything in practice. */
  private async latestPublishedFormulas(classSlug: string, classVersion: number): Promise<EquipmentClassFormula[]> {
    return this.ds.getRepository(EquipmentClassFormula).createQueryBuilder('f')
      .where('f.class_slug = :classSlug', { classSlug })
      .andWhere('f.class_version = :classVersion', { classVersion })
      .andWhere('f.compiled_plan IS NOT NULL')
      .getMany();
  }

  private async latestPublishedAlertTemplates(classSlug: string): Promise<AlertRuleTemplate[]> {
    const rows = await this.ds.getRepository(AlertRuleTemplate).find({
      where: { equipmentClassSlug: classSlug, status: 'published' },
      order: { slug: 'ASC', version: 'DESC' },
    });
    const latest = new Map<string, AlertRuleTemplate>();
    for (const row of rows) {
      const seen = latest.get(row.slug);
      if (!seen || row.version > seen.version) latest.set(row.slug, row);
    }
    return [...latest.values()];
  }

  /**
   * Overwrites one client scenario with a template version, on the client's request.
   *
   * The only path by which a template update reaches a copy, and it is initiated by
   * the tenant rather than by Things Alive. It runs in the tenant's own session, so
   * the write is the client's own write in every sense the database recognises.
   *
   * Deliberately destructive: it restores the template, discarding whatever the
   * client had changed. Merging would require guessing which of their edits were
   * deliberate, and a half-merged threshold is worse than either version.
   */
  async adoptScenarioTemplate(
    scope: { tenantId: string; userId: string },
    slug: string,
    templateSlug: string,
    version: number,
    now = new Date(),
  ): Promise<ClientScenario> {
    const rows = await this.ds.getRepository(ScenarioDefinition).find({
      where: { slug: templateSlug, version, status: 'published' },
      take: 1,
    });
    const template = rows[0];
    if (!template) throw new Error(`No published template "${templateSlug}" v${version}.`);

    return withTenantId(this.ds, scope.tenantId, async (m) => {
      const repo = m.getRepository(ClientScenario);
      const row = await repo.findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!row) throw new Error(`No scenario "${slug}" in tenant ${scope.tenantId}.`);

      Object.assign(row, {
        name: template.name,
        description: template.description,
        severity: template.severity,
        tier: template.tier,
        requiredSignals: template.requiredSignals,
        minimumHistoryDays: template.minimumHistoryDays,
        parameters: template.parameters,
        templateVersion: template.version,
        templateChecksum: scenarioContentChecksum(template),
        copiedAt: now,
        updatedBy: scope.userId,
      });
      this.logger.log(
        `Tenant ${scope.tenantId} adopted "${templateSlug}" v${version} over "${slug}".`,
      );
      return repo.save(row);
    });
  }

  /** The latest published version of a template, for the "newer available" signal. */
  async latestTemplateVersion(slug: string): Promise<number | null> {
    return (await this.latestPublishedClass(slug))?.version ?? null;
  }

  async latestScenarioTemplateVersion(slug: string): Promise<number | null> {
    const rows = await this.ds.getRepository(ScenarioDefinition).find({
      where: { slug, status: 'published' },
      order: { version: 'DESC' },
      take: 1,
    });
    return rows[0]?.version ?? null;
  }
}
