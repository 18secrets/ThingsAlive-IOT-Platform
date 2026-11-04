import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { runTenantSpanning } from '../scope/tenant-session';
import { VaniTransport } from './vani-client';
import { VaniCall } from './vani.entities';

/** Attempts before a call request is given up on. Mirrors the outbox (QNOTIFY1 Q5). */
export const MAX_ATTEMPTS = 5;
/** Wait after the 1st, 2nd, 3rd and 4th failure, in minutes. */
export const BACKOFF_MINUTES = [1, 2, 4, 8] as const;
/**
 * A request older than this is not sent. A phone call about yesterday's alert reaches
 * somebody who has either dealt with it or stopped trusting the calls — and the first
 * pass after VANI_PLATFORM_TOKEN is set would otherwise phone about every alert queued
 * while it was missing.
 */
export const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1000;

export interface SendResult {
  accepted: number;
  rejected: number;
  retried: number;
  failed: number;
}

/**
 * Sends queued `vani_call` requests to Vani and records its answer (integration
 * guide §6.2).
 *
 * One request per transaction, claimed with FOR NO KEY UPDATE SKIP LOCKED: two senders
 * take different rows, and the answer commits together with the state change. NO KEY,
 * not plain FOR UPDATE, so Vani's outcome callback — which can arrive while this
 * transaction still waits on the POST — inserts its row without queueing behind it.
 *
 * At least once. A crash after Vani answered and before the commit leaves the row
 * pending, the next pass resends the same body, and Vani answers `duplicate` with the
 * original call. That is the guide's contract and the reason the alert id is the
 * event id.
 */
export class VaniCallSender {
  private readonly logger = new Logger(VaniCallSender.name);

  constructor(private readonly ds: DataSource, private readonly vani: VaniTransport) {}

  async pass(now = new Date(), limit = 20): Promise<SendResult> {
    const result: SendResult = { accepted: 0, rejected: 0, retried: 0, failed: 0 };
    // Unconfigured, nothing is claimed: the rows wait, untouched, rather than burning
    // their attempts against a token nobody has set yet.
    if (!this.vani.configured) return result;
    for (let i = 0; i < limit; i++) {
      const outcome = await this.one(now);
      if (!outcome) break;
      result[outcome] += 1;
    }
    return result;
  }

  private one(now: Date): Promise<keyof SendResult | null> {
    return runTenantSpanning(this.ds, 'vani call send', async (m) => {
      const rows: { id: string }[] = await m.query(
        `SELECT "id" FROM "vani_call"
          WHERE "state" = 'pending' AND "next_attempt_at" <= $1
          ORDER BY "created_at"
          LIMIT 1
          FOR NO KEY UPDATE SKIP LOCKED`,
        [now],
      );
      if (!rows.length) return null;
      const repo = m.getRepository(VaniCall);
      const call = (await repo.findOne({ where: { id: rows[0].id } }))!;

      if (now.getTime() - call.createdAt.getTime() > MAX_REQUEST_AGE_MS) {
        await this.settle(m, call, now, { state: 'failed', lastError: 'expired before Vani could be reached (older than 24 hours)' });
        return 'failed';
      }

      const attempts = call.attempts + 1;
      let status: number;
      let body: Record<string, unknown>;
      try {
        ({ status, body } = await this.vani.post('/platform/alert-call', call.request));
      } catch (err) {
        return this.retry(m, call, now, attempts, null, `Vani could not be reached: ${(err as Error).message}`);
      }

      if (status === 202 || (status === 200 && body.status === 'duplicate')) {
        await this.settle(m, call, now, {
          state: 'accepted', attempts, httpStatus: status, lastError: null,
          triggerId: str(body.trigger_id), callId: str(body.call_id), vaniStatus: str(body.status),
          disposition: str(body.disposition), reason: str(body.reason), retryAt: date(body.retry_at),
        });
        return 'accepted';
      }
      if (status === 422) {
        // The guide: fix the payload, never resend it unchanged. The body here is fixed
        // by design, so this request is finished; the reason says what to fix.
        const reason = str(body.error) ?? 'refused with no reason given';
        await this.settle(m, call, now, { state: 'rejected', attempts, httpStatus: status, reason, lastError: reason });
        this.logger.warn(`Vani refused the call for alert ${call.alertEventId}: ${reason}`);
        return 'rejected';
      }
      // 401 is a token problem on our side, put right by fixing the token, after which
      // the same request succeeds — so it retries like an outage rather than ending here.
      const why = status === 401
        ? 'Vani refused the platform token (401); check VANI_PLATFORM_TOKEN'
        : `Vani answered ${status}${str(body.error) ? `: ${str(body.error)}` : ''}`;
      return this.retry(m, call, now, attempts, status, why);
    });
  }

  private async retry(
    m: EntityManager, call: VaniCall, now: Date, attempts: number, httpStatus: number | null, error: string,
  ): Promise<keyof SendResult> {
    if (attempts >= MAX_ATTEMPTS) {
      await this.settle(m, call, now, { state: 'failed', attempts, httpStatus, lastError: error });
      this.logger.warn(`Gave up on the Vani call for alert ${call.alertEventId}: ${error}`);
      return 'failed';
    }
    const wait = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60_000;
    await this.settle(m, call, now, {
      attempts, httpStatus, lastError: error, nextAttemptAt: new Date(now.getTime() + wait),
    });
    return 'retried';
  }

  private settle(m: EntityManager, call: VaniCall, now: Date, changes: Partial<VaniCall>): Promise<unknown> {
    return m.getRepository(VaniCall).update(call.id, { ...changes, updatedAt: now });
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
