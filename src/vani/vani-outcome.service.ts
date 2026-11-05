import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { runTenantSpanning, withTenantSession } from '../scope/tenant-session';
import { checkVaniSecret } from './vani-secret';
import { VANI_OUTCOMES, VaniCall, VaniCallOutcome, VaniOutcome } from './vani.entities';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutcomeAck {
  ok: true;
  duplicate: boolean;
}

/**
 * Vani's report of each call attempt, and the call history the UI reads
 * (integration guide §6.3).
 */
@Injectable()
export class VaniOutcomeService {
  constructor(private readonly ds: DataSource) {}

  /**
   * The callback has no user token behind it, so it proves itself with the shared
   * secret (`vani-secret.ts`). Vani retries a refused callback once, then keeps the
   * outcome in its own records.
   */
  checkSecret(presented: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
    checkVaniSecret(presented, env);
  }

  /**
   * Records one outcome, once. A repeat of the same (event, attempt) is acknowledged
   * and changes nothing: Vani retries a callback whose answer it did not see, and the
   * first one may well have landed.
   */
  async record(raw: unknown): Promise<OutcomeAck> {
    const body = parse(raw);
    return runTenantSpanning(this.ds, 'vani outcome callback', async (m) => {
      // Tenant-spanning because the callback says which account, not which tenant;
      // the call row is what turns one into the other.
      const call = await m.getRepository(VaniCall).findOneBy({ alertEventId: body.event_id });
      if (!call) throw new NotFoundException(`No Vani call was requested for event ${body.event_id}.`);
      if (call.vaniAccountId !== body.account_id || call.machineId !== body.machine_id) {
        throw new BadRequestException(`Event ${body.event_id} was not a call to ${body.account_id} about ${body.machine_id}.`);
      }
      const inserted: unknown[] = await m.query(
        `INSERT INTO "vani_call_outcome"
           ("tenant_id", "alert_event_id", "attempt", "call_id", "outcome", "summary", "duration_s", "called_at", "payload")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("tenant_id", "alert_event_id", "attempt") DO NOTHING
         RETURNING "id"`,
        [call.tenantId, call.alertEventId, body.attempt, body.call_id, body.outcome, body.summary,
          body.duration_s, body.called_at, JSON.stringify(raw)],
      );
      return { ok: true, duplicate: inserted.length === 0 };
    });
  }

  /** The calls made about alerts the caller can see, newest first, each with its outcomes. */
  async list(scope: RequestScope, filter: { alertEventId?: string; externalId?: string } = {}) {
    if (filter.alertEventId && !UUID.test(filter.alertEventId)) throw new BadRequestException('alert must be a UUID.');
    return withTenantSession(this.ds, scope, async (m) => {
      // Undefined is unrestricted, [] matches nothing — the same reading as the alert list.
      if (scope.equipmentIds !== undefined) {
        if (scope.equipmentIds.length === 0) return [];
        if (filter.externalId && !scope.equipmentIds.includes(filter.externalId)) return [];
      }
      const params: unknown[] = [scope.tenantId];
      const where = [`c."tenant_id" = $1`];
      if (filter.alertEventId) { params.push(filter.alertEventId); where.push(`c."alert_event_id" = $${params.length}`); }
      if (filter.externalId) { params.push(filter.externalId); where.push(`a."external_id" = $${params.length}`); }
      if (scope.equipmentIds !== undefined && !filter.externalId) {
        params.push([...scope.equipmentIds]); where.push(`a."external_id" = ANY($${params.length}::text[])`);
      }
      const calls: Record<string, any>[] = await m.query(
        `SELECT c."alert_event_id", a."source_system", a."external_id", a."rule_name", c."machine_id",
                c."severity", c."state", c."attempts", c."call_id", c."vani_status", c."disposition",
                c."reason", c."retry_at", c."last_error", c."created_at", c."updated_at"
           FROM "vani_call" c JOIN "alert_event" a ON a."id" = c."alert_event_id"
          WHERE ${where.join(' AND ')}
          ORDER BY c."created_at" DESC
          LIMIT 200`,
        params,
      );
      if (!calls.length) return [];
      const outcomes = await m.getRepository(VaniCallOutcome).find({
        where: { tenantId: scope.tenantId, alertEventId: In(calls.map((c) => c.alert_event_id)) },
        order: { attempt: 'ASC' },
      });
      return calls.map((c) => ({
        alertEventId: c.alert_event_id,
        sourceSystem: c.source_system,
        externalId: c.external_id,
        alertName: c.rule_name,
        machineId: c.machine_id,
        severity: c.severity,
        state: c.state,
        attempts: c.attempts,
        callId: c.call_id,
        vaniStatus: c.vani_status,
        disposition: c.disposition,
        reason: c.reason,
        retryAt: c.retry_at,
        lastError: c.last_error,
        requestedAt: c.created_at,
        updatedAt: c.updated_at,
        outcomes: outcomes.filter((o) => o.alertEventId === c.alert_event_id).map((o) => ({
          attempt: o.attempt, callId: o.callId, outcome: o.outcome,
          // Written by Vani for an alert history. Shown as sent.
          summary: o.summary, durationS: o.durationS, calledAt: o.calledAt, receivedAt: o.receivedAt,
        })),
      }));
    });
  }
}

interface OutcomeBody {
  event_id: string;
  account_id: string;
  machine_id: string;
  attempt: number;
  outcome: VaniOutcome;
  call_id: string | null;
  summary: string | null;
  duration_s: number | null;
  called_at: string | null;
}

/**
 * Checked by hand rather than through a DTO. The global ValidationPipe refuses
 * unknown fields, and Vani adding one to its callback would then cost every outcome
 * until we noticed. What we rely on is checked strictly; anything else is kept in the
 * stored payload.
 */
function parse(raw: unknown): OutcomeBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Expected a JSON object.');
  const b = raw as Record<string, unknown>;
  const problems: string[] = [];
  const text = (k: string, required: boolean): string | null => {
    const v = b[k];
    if (v === undefined || v === null || v === '') {
      if (required) problems.push(`${k} is required`);
      return null;
    }
    if (typeof v !== 'string') { problems.push(`${k} must be a string`); return null; }
    return v;
  };
  const eventId = text('event_id', true);
  if (eventId && !UUID.test(eventId)) problems.push('event_id is not one of ours');
  const accountId = text('account_id', true);
  const machineId = text('machine_id', true);
  const outcome = text('outcome', true);
  if (outcome && !(VANI_OUTCOMES as readonly string[]).includes(outcome)) problems.push(`outcome "${outcome}" is not one Vani sends`);
  const attempt = b.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) problems.push('attempt must be a whole number, 0 or more');
  const duration = b.duration_s;
  if (duration !== undefined && duration !== null && (typeof duration !== 'number' || duration < 0)) problems.push('duration_s must be a number');
  const calledAt = text('called_at', false);
  if (calledAt && Number.isNaN(new Date(calledAt).getTime())) problems.push('called_at is not a timestamp');
  const callId = text('call_id', false);
  const summary = text('summary', false);
  if (problems.length) throw new BadRequestException(problems.join('; '));
  return {
    event_id: eventId!, account_id: accountId!, machine_id: machineId!, attempt: attempt as number,
    outcome: outcome as VaniOutcome, call_id: callId, summary,
    duration_s: (duration as number | null | undefined) ?? null, called_at: calledAt,
  };
}
