import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientScenario } from '../entities/client-scenario.entity';
import { ClientEquipmentClassFailureMode } from '../entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../entities/client-equipment-class-recommendation.entity';
import { fromFailureModeJsonb, severityGiven } from '../../catalog/services/class-failure-modes';
import { ClientEquipmentClassLayout } from '../entities/client-equipment-class-layout.entity';
import { ClientFormula } from '../entities/client-formula.entity';
import { fallbackLayout, TenantLayoutWidget } from '../../catalog/layout/layout-rules';
import { presentationOf } from '../../catalog/services/class-layout';
import { CopyOnGrantService } from './copy-on-grant.service';

const toTenantWidget = (r: ClientEquipmentClassLayout): TenantLayoutWidget => ({
  widgetType: r.widgetType, widgetKey: r.widgetKey, boundTo: r.boundTo, title: r.title,
  position: r.position, size: r.size, hidden: r.hidden, positionCustom: r.positionCustom,
});
import {
  Provenance, classContentChecksum, describeProvenance, scenarioContentChecksum,
} from './provenance';

export type ClassEdit = Partial<Pick<ClientEquipmentClass,
  'name' | 'description' | 'category' | 'expectedSignals' | 'failureModes' | 'defaultThresholds'>>;

export type ScenarioEdit = Partial<Pick<ClientScenario,
  'name' | 'description' | 'severity' | 'tier' | 'requiredSignals'
  | 'minimumHistoryDays' | 'parameters' | 'enabled'>>;

/**
 * The client's own catalog: read by everyone in the tenant, written by super admin.
 *
 * Everything here runs inside the tenant's row-level-security session, so one
 * client's edit cannot reach another's rows even if a slug collided. The scope is not
 * a parameter these methods could get wrong — it is the session they run in.
 *
 * There is no bounds check against the template. The client owns these rows; a super
 * admin who wants a coolant shutdown above the engine builder's limit can set one.
 * What the platform does instead is remember what the copy started as, so the
 * difference is visible to whoever is asked about it later.
 */
@Injectable()
export class ClientCatalogService {
  private readonly logger = new Logger(ClientCatalogService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly copies: CopyOnGrantService,
  ) {}

  async classes(scope: RequestScope): Promise<(ClientEquipmentClass & { provenance: Provenance })[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const rows = await m.getRepository(ClientEquipmentClass).find({
        where: { tenantId: scope.tenantId },
        order: { slug: 'ASC' },
      });
      return Promise.all(rows.map(async (row) => ({
        ...row,
        provenance: describeProvenance(
          row,
          classContentChecksum(row),
          row.templateSlug ? await this.copies.latestTemplateVersion(row.templateSlug) : null,
        ),
      })));
    });
  }

  async oneClass(scope: RequestScope, slug: string): Promise<ClientEquipmentClass> {
    return withTenantSession(this.ds, scope, async (m) => {
      const row = await m.getRepository(ClientEquipmentClass)
        .findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!row) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
      return row;
    });
  }

  async editClass(scope: RequestScope, slug: string, edit: ClassEdit): Promise<ClientEquipmentClass> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(ClientEquipmentClass);
      const row = await repo.findOne({ where: { tenantId: scope.tenantId, slug } });
      if (!row) throw new NotFoundException(`No equipment class "${slug}" in this account.`);

      // Provenance is not editable. A client rewriting where their copy came from
      // would make the divergence signal say whatever they wanted it to say.
      Object.assign(row, edit, { updatedBy: scope.userId });
      this.logger.log(`Tenant ${scope.tenantId} edited class "${slug}" (by ${scope.userId}).`);
      const saved = await repo.save(row);
      if (edit.failureModes) await this.replaceFailureModes(m, scope.tenantId, slug, edit.failureModes);
      return saved;
    });
  }

  /**
   * The rows are what is read (task QREC0a); the jsonb edit above is still applied,
   * deprecated, so the two never disagree. A failure mode one of the tenant's own
   * recommendations still points at cannot be removed — refused naming both, rather
   * than left to the foreign key's constraint name.
   */
  private async replaceFailureModes(
    m: EntityManager, tenantId: string, slug: string, modes: ClientEquipmentClass['failureModes'],
  ): Promise<void> {
    const repo = m.getRepository(ClientEquipmentClassFailureMode);
    const existing = await repo.find({ where: { tenantId, clientEquipmentClassSlug: slug } });
    const wanted = new Map(fromFailureModeJsonb(modes).map((f) => [f.code, f]));
    const removed = existing.filter((r) => !wanted.has(r.code));
    if (removed.length) {
      const recs = await m.getRepository(ClientEquipmentClassRecommendation).find({
        where: { tenantId, clientEquipmentClassSlug: slug },
      });
      const blocked = recs.filter((r) => removed.some((f) => f.code === r.failureModeCode));
      if (blocked.length) {
        throw new BadRequestException(
          blocked.map((r) => `Recommendation "${r.action}" points at failure mode "${r.failureModeCode}"`).join('; ')
            + '. Remove or repoint the recommendation before removing the failure mode.',
        );
      }
      await repo.remove(removed);
    }
    const byCode = new Map(existing.map((r) => [r.code, r]));
    await repo.save([...wanted.values()].map((f) => {
      const prior = byCode.get(f.code);
      return repo.create({
        ...(prior ?? { tenantId, clientEquipmentClassSlug: slug }), ...f,
        // The edit speaks the jsonb shape, which has no severity: an edit that does
        // not mention one keeps the copied one rather than erasing it.
        severity: severityGiven(modes, f.code) ? f.severity : prior?.severity ?? null,
      });
    }));
  }

  /**
   * The account's page layout for one class (task QREC0b). When the class was
   * granted with no layout, the page is the computed fallback over the account's own
   * formula copies, and says so — an editor has to know there are no rows to hide or
   * reorder yet.
   */
  async layout(scope: RequestScope, slug: string): Promise<{ fallback: boolean; widgets: TenantLayoutWidget[] }> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.requireClass(m, scope, slug);
      const rows = await m.getRepository(ClientEquipmentClassLayout).find({
        where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug }, order: { position: 'ASC' },
      });
      if (rows.length) {
        return { fallback: false, widgets: rows.map(toTenantWidget) };
      }
      const formulas = await m.getRepository(ClientFormula).find({
        where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug, status: 'active' },
      });
      return {
        fallback: true,
        widgets: fallbackLayout(formulas.map(presentationOf)).map((w) => ({ ...w, hidden: false, positionCustom: false })),
      };
    });
  }

  async setWidgetHidden(scope: RequestScope, slug: string, widgetKey: string, hidden: boolean) {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(ClientEquipmentClassLayout);
      const row = await repo.findOne({ where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug, widgetKey } });
      if (!row) throw new NotFoundException(`No widget "${widgetKey}" on "${slug}" in this account.`);
      row.hidden = hidden;
      this.logger.log(`Tenant ${scope.tenantId} ${hidden ? 'hid' : 'showed'} "${widgetKey}" on "${slug}".`);
      return toTenantWidget(await repo.save(row));
    });
  }

  /**
   * A reorder names every widget, in the order wanted — a permutation, not a patch, so
   * there is no position left half-assigned. A widget that ends up somewhere other
   * than where the class put it is marked custom, which is what a new class version
   * respects instead of reverting (mergeTenantLayout).
   */
  async reorderLayout(scope: RequestScope, slug: string, widgetKeys: string[]) {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(ClientEquipmentClassLayout);
      const rows = await repo.find({ where: { tenantId: scope.tenantId, clientEquipmentClassSlug: slug } });
      const have = new Set(rows.map((r) => r.widgetKey));
      const given = new Set(widgetKeys);
      const missing = [...have].filter((k) => !given.has(k));
      const unknown = [...given].filter((k) => !have.has(k));
      if (!rows.length || missing.length || unknown.length || given.size !== widgetKeys.length) {
        throw new BadRequestException(
          `A reorder names every widget on "${slug}" exactly once.`
            + (missing.length ? ` Missing: ${missing.join(', ')}.` : '')
            + (unknown.length ? ` Not on this page: ${unknown.join(', ')}.` : '')
            + (given.size !== widgetKeys.length ? ' A widget is named twice.' : ''),
        );
      }
      const byKey = new Map(rows.map((r) => [r.widgetKey, r]));
      widgetKeys.forEach((key, i) => {
        const row = byKey.get(key)!;
        if (row.position !== i + 1) {
          row.position = i + 1;
          row.positionCustom = true;
        }
      });
      // Saved in one transaction; uq_client_layout_position is deferred to commit, so
      // a swap passing through a duplicate position mid-save is not refused.
      await repo.save(rows);
      this.logger.log(`Tenant ${scope.tenantId} reordered the "${slug}" page.`);
      return rows.sort((a, b) => a.position - b.position).map(toTenantWidget);
    });
  }

  private async requireClass(m: EntityManager, scope: RequestScope, slug: string): Promise<void> {
    const found = await m.getRepository(ClientEquipmentClass).count({ where: { tenantId: scope.tenantId, slug } });
    if (!found) throw new NotFoundException(`No equipment class "${slug}" in this account.`);
  }

  async scenarios(scope: RequestScope, classSlug?: string): Promise<ClientScenario[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(ClientScenario).find({
        where: {
          tenantId: scope.tenantId,
          ...(classSlug ? { clientEquipmentClassSlug: classSlug } : {}),
        },
        order: { slug: 'ASC' },
      }),
    );
  }

  async oneScenario(scope: RequestScope, slug: string): Promise<ClientScenario & { provenance: Provenance }> {
    return withTenantSession(this.ds, scope, async (m) => {
      const row = await this.requireScenario(m, scope, slug);
      return {
        ...row,
        provenance: describeProvenance(
          row,
          scenarioContentChecksum(row),
          row.templateSlug ? await this.copies.latestScenarioTemplateVersion(row.templateSlug) : null,
        ),
      };
    });
  }

  async editScenario(scope: RequestScope, slug: string, edit: ScenarioEdit): Promise<ClientScenario> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(ClientScenario);
      const row = await this.requireScenario(m, scope, slug);

      if (edit.requiredSignals) {
        // A scenario cannot require a signal its own class does not declare — the
        // same rule the template seeder enforces, for the same reason: the
        // recommendation engine cannot tell a typo from an absent sensor, and would
        // tell the customer to fit one they already have.
        const owner = await m.getRepository(ClientEquipmentClass).findOne({
          where: { tenantId: scope.tenantId, slug: row.clientEquipmentClassSlug },
        });
        const declared = new Set((owner?.expectedSignals ?? []).map((s) => s.signal));
        const unknown = edit.requiredSignals.filter((s) => !declared.has(s));
        if (unknown.length) {
          throw new BadRequestException(
            `"${row.clientEquipmentClassSlug}" does not declare: ${unknown.join(', ')}. `
            + 'Add the signal to the equipment class first.',
          );
        }
      }

      Object.assign(row, edit, { updatedBy: scope.userId });
      this.logger.log(`Tenant ${scope.tenantId} edited scenario "${slug}" (by ${scope.userId}).`);
      return repo.save(row);
    });
  }

  /**
   * Puts a copy back to the template it came from, at the latest published version.
   *
   * The only way a template update reaches a client, and it is the client who asks.
   * Things Alive pushing it would be editing a client's settings, which this model
   * forbids — so the newer version is offered through `provenance` and adopted here.
   */
  async adoptLatestTemplate(scope: RequestScope, slug: string): Promise<ClientScenario> {
    const row = await this.oneScenario(scope, slug);
    if (!row.templateSlug) {
      throw new BadRequestException(`"${slug}" was written in this account; it has no template.`);
    }
    const latest = await this.copies.latestScenarioTemplateVersion(row.templateSlug);
    if (latest === null) {
      throw new BadRequestException(`No published template "${row.templateSlug}" to adopt.`);
    }
    return this.copies.adoptScenarioTemplate(scope, slug, row.templateSlug, latest);
  }

  private async requireScenario(
    m: EntityManager, scope: RequestScope, slug: string,
  ): Promise<ClientScenario> {
    const row = await m.getRepository(ClientScenario)
      .findOne({ where: { tenantId: scope.tenantId, slug } });
    if (!row) throw new NotFoundException(`No scenario "${slug}" in this account.`);
    return row;
  }
}
