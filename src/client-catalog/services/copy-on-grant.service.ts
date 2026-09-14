import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../../catalog/entities/scenario-definition.entity';
import { withTenantId } from '../../scope/tenant-session';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientScenario } from '../entities/client-scenario.entity';
import { classContentChecksum, scenarioContentChecksum } from './provenance';

export interface CopyResult {
  classSlug: string;
  templateVersion: number;
  scenariosCopied: number;
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

    return withTenantId(this.ds, tenantId, async (m: EntityManager) => {
      const classes = m.getRepository(ClientEquipmentClass);
      const existing = await classes.findOne({ where: { tenantId, slug: template.slug } });
      if (existing) {
        this.logger.log(
          `Tenant ${tenantId} already has "${template.slug}"; leaving their copy alone.`,
        );
        return {
          classSlug: existing.slug,
          templateVersion: existing.templateVersion ?? template.version,
          scenariosCopied: 0,
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
        failureModes: template.failureModes,
        defaultThresholds: template.defaultThresholds,
        templateSlug: template.slug,
        templateVersion: template.version,
        templateChecksum: classContentChecksum(template),
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

      this.logger.log(
        `Copied "${template.slug}" v${template.version} and ${copied} scenario(s) to tenant ${tenantId}.`,
      );
      return {
        classSlug: template.slug,
        templateVersion: template.version,
        scenariosCopied: copied,
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
