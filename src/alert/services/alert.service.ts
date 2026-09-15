import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { Severity } from '../../common/severity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantId, withTenantSession } from '../../scope/tenant-session';
import { AlertAppliesTo, AlertRule } from '../entities/alert-rule.entity';
import { AlertEvent } from '../entities/alert-event.entity';
import {
  AlertParams, AlertTrigger, evaluateRule, validateParams, WindowPrediction, WindowReading,
  WindowChain,
} from './alert-rules';

export interface RuleInput {
  slug: string;
  name: string;
  description?: string | null;
  trigger: AlertTrigger;
  params: AlertParams;
  appliesTo?: AlertAppliesTo;
  plantId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  equipmentClassSlug?: string | null;
  severity?: Severity;
}

export interface WindowContext {
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  shiftLocalDate: string;
  windowStart: Date;
  windowEnd: Date;
  readings: WindowReading[];
  predictions: WindowPrediction[];
  /**
   * What the physical chains said about this window.
   *
   * Optional, and a chain rule simply does not fire without it. That is the right
   * failure: a rule about where a fault entered has nothing to say when nobody ran the
   * chain, and firing on the absence would be an alert about our own plumbing.
   */
  chains?: WindowChain[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Alerts: the client's own standing requests to be told something (task P1-119).
 *
 * `alert.author` was the second capability every client role was granted and no route
 * required — the same quiet failure `action.work` had, and the same fix.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(private readonly ds: DataSource) {}

  async listRules(scope: RequestScope): Promise<AlertRule[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(AlertRule).find({
        where: { tenantId: scope.tenantId }, order: { name: 'ASC' },
      }));
  }

  async createRule(scope: RequestScope, input: RuleInput): Promise<AlertRule> {
    await this.validate(scope, input);
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AlertRule);
      if (await repo.findOne({ where: { tenantId: scope.tenantId, slug: input.slug } })) {
        throw new ConflictException(`A rule called "${input.slug}" already exists.`);
      }
      return repo.save(repo.create({
        tenantId: scope.tenantId,
        slug: input.slug,
        name: input.name.trim(),
        description: input.description ?? null,
        trigger: input.trigger,
        params: input.params,
        appliesTo: input.appliesTo ?? 'account',
        plantId: input.plantId ?? null,
        sourceSystem: input.sourceSystem ?? null,
        externalId: input.externalId ?? null,
        equipmentClassSlug: input.equipmentClassSlug ?? null,
        severity: input.severity ?? Severity.High,
        enabled: true,
        createdBy: scope.userId,
        updatedBy: scope.userId,
      }));
    });
  }

  async updateRule(scope: RequestScope, id: string, input: Partial<RuleInput>): Promise<AlertRule> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AlertRule);
      const rule = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!rule) throw new NotFoundException('No such alert rule in this account.');

      const merged: RuleInput = {
        slug: input.slug ?? rule.slug,
        name: input.name ?? rule.name,
        description: input.description ?? rule.description,
        trigger: input.trigger ?? rule.trigger,
        params: input.params ?? rule.params,
        appliesTo: input.appliesTo ?? rule.appliesTo,
        plantId: input.plantId !== undefined ? input.plantId : rule.plantId,
        sourceSystem: input.sourceSystem !== undefined ? input.sourceSystem : rule.sourceSystem,
        externalId: input.externalId !== undefined ? input.externalId : rule.externalId,
        equipmentClassSlug: input.equipmentClassSlug !== undefined
          ? input.equipmentClassSlug : rule.equipmentClassSlug,
        severity: input.severity ?? rule.severity,
      };
      await this.validate(scope, merged);
      if (merged.slug !== rule.slug) {
        const clash = await repo.findOne({
          where: { tenantId: scope.tenantId, slug: merged.slug, id: Not(id) },
        });
        if (clash) throw new ConflictException(`A rule called "${merged.slug}" already exists.`);
      }

      Object.assign(rule, merged, { name: merged.name.trim(), updatedBy: scope.userId });
      return repo.save(rule);
    });
  }

  /** Off rather than deleted: the alerts it raised still have to be explainable. */
  async setEnabled(scope: RequestScope, id: string, enabled: boolean): Promise<AlertRule> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AlertRule);
      const rule = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!rule) throw new NotFoundException('No such alert rule in this account.');
      rule.enabled = enabled;
      rule.updatedBy = scope.userId;
      return repo.save(rule);
    });
  }

  async listEvents(
    scope: RequestScope, filter: { state?: string[]; externalId?: string } = {},
  ): Promise<AlertEvent[]> {
    return withTenantSession(this.ds, scope, (m) => {
      const where: Record<string, unknown> = { tenantId: scope.tenantId };
      if (filter.state?.length) where.state = In(filter.state);
      if (filter.externalId) where.externalId = filter.externalId;

      // Undefined is unrestricted, [] matches nothing. Reading the empty case as "no
      // filter" would hand somebody assigned to no machines every alert in the account.
      if (scope.equipmentIds !== undefined) {
        if (scope.equipmentIds.length === 0) return Promise.resolve([]);
        if (filter.externalId && !scope.equipmentIds.includes(filter.externalId)) {
          return Promise.resolve([]);
        }
        if (!filter.externalId) where.externalId = In([...scope.equipmentIds]);
      }
      return m.getRepository(AlertEvent).find({
        where: where as any, order: { firedAt: 'DESC' }, take: 200,
      });
    });
  }

  async acknowledge(scope: RequestScope, id: string, now = new Date()): Promise<AlertEvent> {
    return this.transition(scope, id, 'acknowledged', null, now);
  }

  async resolve(scope: RequestScope, id: string, note: string, now = new Date()): Promise<AlertEvent> {
    if (!note?.trim()) {
      throw new BadRequestException(
        'A note is required to resolve an alert. What was found is the only part of '
        + 'this anybody reads a month later.',
      );
    }
    return this.transition(scope, id, 'resolved', note.trim(), now);
  }

  private async transition(
    scope: RequestScope, id: string, to: 'acknowledged' | 'resolved',
    note: string | null, now: Date,
  ): Promise<AlertEvent> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(AlertEvent);
      const event = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!event) throw new NotFoundException('No such alert in this account.');
      if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(event.externalId)) {
        throw new NotFoundException('No such alert in this account.');
      }
      if (event.state === 'resolved') {
        throw new BadRequestException('That alert is already resolved.');
      }

      if (to === 'acknowledged') {
        // Seeing it twice is not an event. Keeping the first acknowledgement means
        // "how long before anybody looked" stays answerable.
        if (event.state === 'acknowledged') return event;
        event.state = 'acknowledged';
        event.acknowledgedBy = scope.userId;
        event.acknowledgedAt = now;
      } else {
        // Resolving without acknowledging is ordinary — somebody who fixes it has
        // plainly seen it — so the acknowledgement is filled in rather than demanded.
        event.acknowledgedBy = event.acknowledgedBy ?? scope.userId;
        event.acknowledgedAt = event.acknowledgedAt ?? now;
        event.state = 'resolved';
        event.resolvedBy = scope.userId;
        event.resolvedAt = now;
        event.resolutionNote = note;
      }
      return repo.save(event);
    });
  }

  /**
   * Evaluate every rule that covers this machine against the shift that just closed.
   *
   * Called by the runner with no request behind it, so it takes a tenant id rather
   * than a scope and pins it in every query.
   *
   * An open alert for the same rule and machine suppresses a second one. The same
   * fault on every shift for a week is one thing wrong with one machine, and a list
   * with seven identical rows is a list nobody reads — which is the failure this is
   * meant to prevent rather than cause. Resolving it lifts the suppression, so the
   * fault coming back after somebody signed it off is a new alert.
   */
  async evaluateWindow(context: WindowContext): Promise<AlertEvent[]> {
    return withTenantId(this.ds, context.tenantId, async (m) => {
      const rules = await m.getRepository(AlertRule).find({
        where: { tenantId: context.tenantId, enabled: true },
      });
      if (rules.length === 0) return [];

      const applicable = await this.applicableTo(m, context, rules);
      const fired: AlertEvent[] = [];

      for (const rule of applicable) {
        const firing = evaluateRule({
          trigger: rule.trigger,
          params: rule.params,
          readings: context.readings,
          predictions: context.predictions,
          chains: context.chains,
        });
        if (!firing) continue;

        const repo = m.getRepository(AlertEvent);
        const standing = await repo.findOne({
          where: [
            { tenantId: context.tenantId, ruleId: rule.id, externalId: context.externalId, state: 'open' },
            { tenantId: context.tenantId, ruleId: rule.id, externalId: context.externalId, state: 'acknowledged' },
          ],
        });
        if (standing) continue;

        fired.push(await repo.save(repo.create({
          tenantId: context.tenantId,
          ruleId: rule.id,
          ruleName: rule.name,
          sourceSystem: context.sourceSystem,
          externalId: context.externalId,
          severity: rule.severity,
          summary: firing.summary,
          evidence: firing.evidence,
          shiftLocalDate: context.shiftLocalDate,
          windowStart: context.windowStart,
          windowEnd: context.windowEnd,
          predictionId: firing.predictionId ?? null,
          state: 'open',
          acknowledgedBy: null, acknowledgedAt: null,
          resolvedBy: null, resolvedAt: null, resolutionNote: null,
        })));
      }
      return fired;
    });
  }

  /** Which of these rules cover this machine. */
  private async applicableTo(
    m: EntityManager, context: WindowContext, rules: AlertRule[],
  ): Promise<AlertRule[]> {
    // One read for both, because a rule scoped to a site and one scoped to a class
    // both need the machine's own row, and asking twice for the same row in a loop
    // that runs once per shift per machine is how a scorer gets slow quietly.
    const needsProfile = rules.some(
      (r) => r.appliesTo === 'plant' || r.appliesTo === 'equipment-class',
    );
    const profile = needsProfile
      ? await m.getRepository(EquipmentProfile).findOne({
          where: {
            tenantId: context.tenantId,
            sourceSystem: context.sourceSystem,
            externalId: context.externalId,
          },
          select: { plantId: true, equipmentClassSlug: true },
        })
      : null;
    const plantId = profile?.plantId ?? null;
    const classSlug = profile?.equipmentClassSlug ?? null;

    return rules.filter((rule) => {
      if (rule.appliesTo === 'account') return true;
      if (rule.appliesTo === 'plant') return !!plantId && rule.plantId === plantId;
      // A machine with no class matches no class-scoped rule. Not an oversight: an
      // unclassified machine has nothing the rule was written about, and treating the
      // missing class as a match would fire generator rules on anything unlabelled.
      if (rule.appliesTo === 'equipment-class') {
        return !!classSlug && rule.equipmentClassSlug === classSlug;
      }
      return rule.sourceSystem === context.sourceSystem && rule.externalId === context.externalId;
    });
  }

  private async validate(scope: RequestScope, input: RuleInput): Promise<void> {
    if (!SLUG_PATTERN.test(input.slug ?? '')) {
      throw new BadRequestException(
        'A rule needs a slug of lower-case letters, digits and hyphens.',
      );
    }
    if (!input.name?.trim()) throw new BadRequestException('A rule needs a name.');

    const problem = validateParams(input.trigger, input.params);
    if (problem) throw new BadRequestException(problem);

    const appliesTo = input.appliesTo ?? 'account';
    if (appliesTo === 'plant' && !input.plantId) {
      throw new BadRequestException('A rule scoped to a site needs the site.');
    }
    if (appliesTo === 'equipment' && !(input.sourceSystem && input.externalId)) {
      throw new BadRequestException('A rule scoped to a machine needs the machine.');
    }
    if (appliesTo === 'equipment-class' && !input.equipmentClassSlug) {
      throw new BadRequestException('A rule scoped to a kind of machine needs the class.');
    }
    if (appliesTo === 'equipment') {
      // Checked here rather than left to fire against nothing: a rule pointing at a
      // machine that is not in this account looks configured and never fires, which
      // is the most expensive way for an alert to be wrong.
      const exists = await withTenantSession(this.ds, scope, (m) =>
        m.getRepository(EquipmentProfile).findOne({
          where: {
            tenantId: scope.tenantId,
            sourceSystem: input.sourceSystem!,
            externalId: input.externalId!,
          },
        }));
      if (!exists) throw new NotFoundException('No such machine in this account.');
    }
  }
}
