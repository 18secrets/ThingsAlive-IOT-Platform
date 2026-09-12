import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { Blocker, RecommendationService } from '../../catalog/services/recommendation.service';
import { ClientScenario } from '../../client-catalog/entities/client-scenario.entity';
import { DomainEvent } from '../../events/domain-event.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { ActivationState, EquipmentScenario } from '../entities/equipment-scenario.entity';
import { ScenarioActivationEvent } from '../entities/scenario-activation-event.entity';
import { ActivationAction, transition } from './state-machine';

export interface ResolvedParameter {
  key: string;
  value: unknown;
  /** Which layer supplied the value, so a screen can show what was tuned and where. */
  source: 'scenario-default' | 'asset-override';
}

export interface ActivationView extends EquipmentScenario {
  resolvedParameters: ResolvedParameter[];
}

/**
 * Turning a scenario on and off for one asset (task P1-09).
 *
 * Every transition is one transaction containing three writes: the state, the
 * client-readable history row, and the outbox event. They cannot disagree, and a
 * crash cannot leave a scenario active that nothing downstream was told about.
 *
 * Runs inside the caller's tenant session throughout, so an activation is incapable
 * of landing in another account.
 */
@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly recommendations: RecommendationService,
  ) {}

  async list(
    scope: RequestScope,
    filter: { sourceSystem?: string; externalId?: string; state?: ActivationState } = {},
  ): Promise<ActivationView[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const rows = await m.getRepository(EquipmentScenario).find({
        where: {
          tenantId: scope.tenantId,
          ...(filter.sourceSystem ? { sourceSystem: filter.sourceSystem } : {}),
          ...(filter.externalId ? { externalId: filter.externalId } : {}),
          ...(filter.state ? { state: filter.state } : {}),
        },
        order: { externalId: 'ASC', clientScenarioSlug: 'ASC' },
      });
      return Promise.all(rows.map((row) => this.withResolvedParameters(m, scope, row)));
    });
  }

  /**
   * Applies a transition. The only way any of these rows change.
   *
   * `activate` is the one that checks anything beyond the state machine, because it
   * is the one that makes a promise to the customer.
   */
  async apply(
    scope: RequestScope,
    action: ActivationAction,
    target: { sourceSystem: string; externalId: string; clientScenarioSlug: string },
    options: { reason?: string; parameterOverrides?: Record<string, unknown> } = {},
    now = new Date(),
  ): Promise<ActivationView> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(EquipmentScenario);
      const existing = await repo.findOne({ where: { tenantId: scope.tenantId, ...target } });
      const from: ActivationState | null = existing?.state ?? null;

      const { to } = transition(action, from, options.reason);

      // The scenario has to exist in this account. Activating a slug the client does
      // not own would create a row pointing at nothing, which reads as configured and
      // scores forever against a definition that is not there.
      const scenario = await m.getRepository(ClientScenario).findOne({
        where: { tenantId: scope.tenantId, slug: target.clientScenarioSlug },
      });
      if (!scenario) {
        throw new NotFoundException(
          `No scenario "${target.clientScenarioSlug}" in this account.`,
        );
      }

      const blockers = action === 'activate' || action === 'resume'
        ? await this.gate(scope, target, now)
        : [];

      const row = repo.create({
        ...(existing ?? {}),
        tenantId: scope.tenantId,
        ...target,
        state: to,
        parameterOverrides: options.parameterOverrides
          ?? existing?.parameterOverrides
          ?? {},
        stateChangedBy: scope.userId,
        stateChangedAt: now,
        stateReason: options.reason?.trim() || null,
        ...(to === 'active'
          ? {
            activatedBy: scope.userId,
            activatedAt: now,
            blockersAtActivation: blockers,
          }
          : {}),
      });
      const saved = await repo.save(row);

      const history = m.getRepository(ScenarioActivationEvent);
      await history.save(history.create({
        tenantId: scope.tenantId,
        ...target,
        action,
        fromState: from,
        toState: to,
        reason: options.reason?.trim() || null,
        blockers,
        actorUserId: scope.userId,
        actorRoles: [...scope.roles],
      }));

      // Same transaction as the state change. See DomainEvent for why that matters.
      const events = m.getRepository(DomainEvent);
      await events.save(events.create({
        eventType: `scenario.${to === 'active' ? 'activated' : to}.v1`,
        tenantId: scope.tenantId,
        subject: `${target.sourceSystem}/${target.externalId}/${target.clientScenarioSlug}`,
        payload: {
          action,
          fromState: from,
          toState: to,
          reason: options.reason?.trim() ?? null,
          blockers,
          actor: scope.userId,
        },
        occurredAt: now,
        deliveryState: 'pending',
      }));

      this.logger.log(
        `${scope.tenantId}: ${target.clientScenarioSlug} on ${target.externalId} `
        + `${from ?? 'new'} -> ${to} (by ${scope.userId})`
        + (blockers.length ? ` with ${blockers.length} blocker(s)` : ''),
      );

      return this.withResolvedParameters(m, scope, saved);
    });
  }

  /**
   * What stops an activation, and what only qualifies it.
   *
   * `notApplicable` is refused: the asset is classified as something else, so the
   * scenario could never fire here and an active row would be a lie the customer
   * pays for in confusion.
   *
   * Everything else is allowed and recorded. A client activating a scenario whose
   * sensor is not yet fitted is doing something reasonable — turning it on now so it
   * starts the day the sensor arrives — and refusing that would push them to keep a
   * list of intentions somewhere outside the product. What would be wrong is letting
   * it look healthy, which is why the blockers are stored on the row.
   */
  private async gate(
    scope: RequestScope,
    target: { sourceSystem: string; externalId: string; clientScenarioSlug: string },
    now: Date,
  ): Promise<Blocker[]> {
    const { recommendations } = await this.recommendations.forEquipment(
      scope, target.sourceSystem, target.externalId, now,
    );
    const match = recommendations.find((r) => r.scenarioSlug === target.clientScenarioSlug);

    if (!match) {
      throw new BadRequestException(
        `"${target.clientScenarioSlug}" does not apply to ${target.externalId}. `
        + 'Check the equipment class this asset is assigned to.',
      );
    }
    if (match.bucket === 'notApplicable') {
      throw new BadRequestException(
        `"${target.clientScenarioSlug}" cannot run on ${target.externalId}: `
        + `${match.blockedBy.map((b) => b.code).join(', ')}. `
        + 'Nothing about this asset will change that, so activating it would score nothing.',
      );
    }
    return match.blockedBy;
  }

  /**
   * The three parameter layers, flattened.
   *
   * Reported with the source of each value rather than as a bare map, because
   * "why is this one 88 when the rest of the fleet is 95" is a question a screen
   * should answer without anybody opening two records side by side.
   */
  private async withResolvedParameters(
    m: EntityManager, scope: RequestScope, row: EquipmentScenario,
  ): Promise<ActivationView> {
    const scenario = await m.getRepository(ClientScenario).findOne({
      where: { tenantId: scope.tenantId, slug: row.clientScenarioSlug },
    });

    const resolved: ResolvedParameter[] = (scenario?.parameters ?? []).map((p) => (
      Object.prototype.hasOwnProperty.call(row.parameterOverrides, p.key)
        ? { key: p.key, value: row.parameterOverrides[p.key], source: 'asset-override' as const }
        : { key: p.key, value: p.default, source: 'scenario-default' as const }
    ));

    // An override for a parameter the scenario no longer declares. Surfaced rather
    // than dropped: it is dead configuration, and silently ignoring it is how a
    // customer believes a threshold is in force for months after it stopped being.
    for (const key of Object.keys(row.parameterOverrides)) {
      if (!resolved.some((r) => r.key === key)) {
        resolved.push({ key, value: row.parameterOverrides[key], source: 'asset-override' });
      }
    }

    return { ...row, resolvedParameters: resolved };
  }
}
