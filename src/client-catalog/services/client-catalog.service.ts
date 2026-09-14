import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentClass } from '../entities/client-equipment-class.entity';
import { ClientScenario } from '../entities/client-scenario.entity';
import { CopyOnGrantService } from './copy-on-grant.service';
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
      return repo.save(row);
    });
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
