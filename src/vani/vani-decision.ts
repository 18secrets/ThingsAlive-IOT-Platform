import { HttpException, Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { AlertService } from '../alert/services/alert.service';
import { SCOPE_RESOLVER, ScopeResolver } from '../auth/scope-resolver';
import { RequestScope } from '../auth/types/request-scope';
import { withTenantId, withTenantSession } from '../scope/tenant-session';
import { MAX_TITLE_LENGTH, WorkOrderService } from '../work/services/work-order.service';
import { VaniCall } from './vani.entities';

/** The decisions D57 names. Anything else Vani sends is recorded, never acted on. */
export const VANI_DECISIONS = ['inspection_approved', 'call_back_requested', 'declined', 'acknowledged'] as const;
export type VaniDecision = (typeof VANI_DECISIONS)[number];

export type ActionStatus = 'acted' | 'recorded' | 'not_acted';

export interface DecisionInput {
  attempt: number;
  outcome: string;
  decision: string;
  summary: string | null;
  calledAt: string | null;
}

export interface ActionRecord {
  decision: string;
  status: ActionStatus;
  reason: string | null;
  acknowledged: boolean;
  workOrderId: string | null;
}

interface Customer {
  userId: string;
  name: string;
  scope: RequestScope | null;
  /** Why there is no scope, when there is none. */
  refusal: string | null;
}

/**
 * Acts on what a customer decided on a Vani call (D57, Lane D): an acknowledgement
 * acknowledges the alert; an approved inspection acknowledges it and raises the job.
 * A call-back request or a "no" is recorded and nothing more.
 *
 * Done as the customer: the number Vani dialled, matched to one 2.0 user in the
 * tenant, with the access `ScopeResolver` gives them when they sign in. So a customer
 * whose role cannot raise jobs gets no job from saying yes on the phone either, and a
 * suspended user gets nothing done on their word.
 *
 * Only on `completed_spoke_with_customer`. Vani acts on what it heard and read back;
 * a decision on a voicemail or an unanswered call is a decision nobody made.
 */
@Injectable()
export class VaniDecisionService {
  constructor(
    private readonly ds: DataSource,
    private readonly alerts: AlertService,
    private readonly work: WorkOrderService,
    @Inject(SCOPE_RESOLVER) private readonly resolver: ScopeResolver,
  ) {}

  /**
   * Acts once per call. Every callback that carries a decision comes through here,
   * repeats included, so an action that failed on a fault is taken on Vani's retry;
   * one already taken is returned as it was.
   */
  async act(call: VaniCall, input: DecisionInput, now = new Date()): Promise<ActionRecord> {
    const customer = await this.customer(call);
    const run = <R>(fn: (m: EntityManager) => Promise<R>) => (customer?.scope
      ? withTenantSession(this.ds, customer.scope, fn)
      : withTenantId(this.ds, call.tenantId, fn));

    return run(async (m) => {
      // Two callbacks for the same call at the same moment: the second waits here for
      // the first to commit, then finds its row. The unique index holds it if not.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('vani_call_action'), hashtext($1))`,
        [`${call.tenantId}/${call.alertEventId}`]);
      const [done] = await m.query(
        `SELECT "decision", "status", "reason", "acknowledged", "work_order_id"
           FROM "vani_call_action" WHERE "tenant_id" = $1 AND "alert_event_id" = $2`,
        [call.tenantId, call.alertEventId]);
      if (done) return toRecord(done);

      const result = await this.decide(m, call, input, customer, now);
      await m.query(
        `INSERT INTO "vani_call_action"
           ("tenant_id", "alert_event_id", "attempt", "decision", "status", "reason", "acted_as_user_id",
            "acknowledged", "work_order_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [call.tenantId, call.alertEventId, input.attempt, input.decision, result.status, result.reason,
          customer?.userId ?? null,
          result.acknowledged, result.workOrderId]);
      return result;
    });
  }

  private async decide(
    m: EntityManager, call: VaniCall, input: DecisionInput, customer: Customer | null, now: Date,
  ): Promise<ActionRecord> {
    const record = (status: ActionStatus, reason: string | null = null): ActionRecord =>
      ({ decision: input.decision, status, reason, acknowledged: false, workOrderId: null });

    if (input.outcome !== 'completed_spoke_with_customer') return record('not_acted', 'not_spoken_with_customer');
    if (!(VANI_DECISIONS as readonly string[]).includes(input.decision)) return record('not_acted', 'unknown_decision');
    if (input.decision === 'call_back_requested' || input.decision === 'declined') return record('recorded');
    if (!customer) return record('not_acted', 'unknown_customer');
    if (!customer.scope) return record('not_acted', customer.refusal ?? 'customer_not_active');

    const alert = await m.getRepository(AlertEvent).findOne({ where: { tenantId: call.tenantId, id: call.alertEventId } });
    if (!alert) return record('not_acted', 'alert_not_found');

    // Inside a savepoint: a refusal part-way (the job, after the acknowledgement) must
    // leave neither, so the row below says "not acted" and is true.
    await m.query('SAVEPOINT vani_act');
    try {
      let acknowledged = false;
      if (alert.state === 'open') {
        await this.alerts.acknowledgeIn(m, customer.scope, alert.id, now);
        acknowledged = true;
      }
      let workOrderId: string | null = null;
      if (input.decision === 'inspection_approved') {
        const order = await this.work.raiseIn(m, customer.scope, {
          sourceSystem: alert.sourceSystem,
          externalId: alert.externalId,
          alertId: alert.id,
          predictionId: alert.predictionId ?? null,
          title: `Inspection agreed on a Vani call: ${alert.ruleName}`.slice(0, MAX_TITLE_LENGTH),
          description: [
            `${customer.name} agreed to an inspection on a Vani call`
              + `${input.calledAt ? ` at ${input.calledAt}` : ''}.`,
            input.summary ? `Vani's summary of the call: ${input.summary}` : null,
          ].filter(Boolean).join('\n\n'),
          // "Act within the week" is what a non-critical alert asks for; a critical
          // one is the platform's night tier (D56), so its job is high priority.
          priority: alert.severity === 'critical' ? 'high' : 'normal',
        }, now);
        workOrderId = order.id;
      }
      if (!acknowledged && !workOrderId) {
        await m.query('RELEASE SAVEPOINT vani_act');
        return record('recorded');
      }
      await m.query('RELEASE SAVEPOINT vani_act');
      return { decision: input.decision, status: 'acted', reason: null, acknowledged, workOrderId };
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      await m.query('ROLLBACK TO SAVEPOINT vani_act');
      const status = err.getStatus();
      return record('not_acted', status === 403 ? 'not_permitted' : status === 404 ? 'not_in_scope' : 'refused');
    }
  }

  /**
   * The person Vani spoke to: the number it dialled, matched to exactly one user in
   * the tenant. Two users on one number is nobody in particular, so nobody.
   */
  private async customer(call: VaniCall): Promise<Customer | null> {
    const request = (call.request ?? {}) as { customer_phone?: string };
    let phone = request.customer_phone ?? null;
    if (!phone) {
      const [link] = await withTenantId(this.ds, call.tenantId, (m) => m.query(
        `SELECT "customer_phone" FROM "vani_account_link" WHERE "tenant_id" = $1`, [call.tenantId]));
      phone = link?.customer_phone ?? null;
    }
    if (!phone) return null;
    const bare = phone.replace(/^\+/, '');
    const users: { id: string; full_name: string }[] = await withTenantId(this.ds, call.tenantId, (m) => m.query(
      `SELECT "id", "full_name" FROM "app_user" WHERE "tenant_id" = $1 AND "phone" IN ($2, $3) LIMIT 2`,
      [call.tenantId, `+${bare}`, bare]));
    if (users.length !== 1) return null;
    const [user] = users;
    try {
      const identity = await this.resolver.resolve(call.tenantId, user.id);
      if (!identity) return { userId: user.id, name: user.full_name, scope: null, refusal: 'customer_not_active' };
      return {
        userId: user.id, name: user.full_name, refusal: null,
        scope: {
          tenantId: call.tenantId, userId: user.id, isPlatformRole: false, roles: identity.roles,
          capabilities: identity.capabilities, plantIds: identity.plantIds, equipmentIds: identity.equipmentIds,
        },
      };
    } catch (err) {
      // Suspended, invitation not accepted, role gone: the resolver refuses them in the
      // app, and the phone does not get round that.
      if (err instanceof HttpException && err.getStatus() === 401) {
        return { userId: user.id, name: user.full_name, scope: null, refusal: 'customer_not_active' };
      }
      throw err;
    }
  }
}

function toRecord(row: any): ActionRecord {
  return {
    decision: row.decision, status: row.status, reason: row.reason,
    acknowledged: row.acknowledged, workOrderId: row.work_order_id,
  };
}
