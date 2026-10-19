import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { runTenantSpanning } from '../scope/tenant-session';
import { DomainEvent } from './domain-event.entity';

/**
 * Every event type anything in 2.0 writes to the outbox. A handler for a type not in
 * this list is refused at construction: a typo in a handler's `eventType` would
 * otherwise register a consumer that never claims anything, and look configured.
 */
export const KNOWN_EVENT_TYPES = ['scenario.activated.v1', 'tenant.provisioned.v1', 'incident.escalated.v1'] as const;
export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** What a handler decided about one event. */
export type HandlerOutcome =
  | { kind: 'delivered' }
  /** Try again after the backoff; `error` is kept on the row. */
  | { kind: 'retry'; error: string }
  /** No retry would help (nobody can receive it, say). Final, and visible as `failed`. */
  | { kind: 'failed'; error: string };

export interface OutboxHandler {
  readonly eventType: KnownEventType;
  /** Runs inside the transaction that holds the event's row lock. */
  handle(m: EntityManager, event: DomainEvent, now: Date): Promise<HandlerOutcome>;
}

/** Attempts before an event is marked `failed` (QNOTIFY1 Q5). */
export const MAX_ATTEMPTS = 5;
/** Wait after the 1st, 2nd, 3rd and 4th failure, in minutes (QNOTIFY1 Q5). */
export const BACKOFF_MINUTES = [1, 2, 4, 8] as const;
/**
 * An event older than this is not delivered (QNOTIFY1 Q3). A page about an incident
 * that went overdue yesterday helps nobody, and the first pass after this ships would
 * otherwise send every escalation ever queued.
 */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
export const EXPIRED_ERROR = 'expired before it could be delivered (older than 24 hours)';

export interface PassResult {
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * The outbox reader D11 described and nothing had built (task QNOTIFY1): it reads
 * `pending` rows and marks them `delivered`.
 *
 * One event per transaction, claimed with FOR UPDATE SKIP LOCKED: two passes running
 * at once take different events rather than the same one twice, and the handler does
 * its work while holding that event's lock, so its writes and the state change commit
 * together. Only types with a registered handler are claimed — a `scenario.activated.v1`
 * stays `pending`, untouched, for whatever consumes it later.
 *
 * Delivery is at least once. A crash after a handler sent something and before the
 * commit leaves the event pending, and the next pass sends again; a handler that must
 * not repeat itself keeps its own unique record (`notification_delivery`).
 */
export class OutboxConsumer {
  private readonly logger = new Logger(OutboxConsumer.name);
  private readonly handlers: Map<string, OutboxHandler>;

  constructor(private readonly ds: DataSource, handlers: OutboxHandler[]) {
    for (const h of handlers) {
      if (!(KNOWN_EVENT_TYPES as readonly string[]).includes(h.eventType)) {
        throw new Error(`No event type "${h.eventType}" is written to the outbox.`);
      }
    }
    this.handlers = new Map(handlers.map((h) => [h.eventType, h]));
  }

  get handledTypes(): string[] {
    return [...this.handlers.keys()];
  }

  async pass(now = new Date(), limit = 20): Promise<PassResult> {
    const result: PassResult = { delivered: 0, retried: 0, failed: 0 };
    if (!this.handlers.size) return result;
    for (let i = 0; i < limit; i++) {
      const outcome = await this.one(now);
      if (!outcome) break;
      result[outcome] += 1;
    }
    return result;
  }

  private async one(now: Date): Promise<keyof PassResult | null> {
    // Tenant-spanning: the outbox belongs to no account, and its reader has no request.
    // Through runTenantSpanning, the one place CI allows the bypass to be set.
    return runTenantSpanning(this.ds, 'outbox pass', async (m) => {
      const rows: { id: string }[] = await m.query(
        `SELECT "id" FROM "domain_event"
          WHERE "delivery_state" = 'pending' AND "event_type" = ANY($1::text[])
            AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $2)
          ORDER BY "occurred_at"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [this.handledTypes, now],
      );
      if (!rows.length) return null;
      const repo = m.getRepository(DomainEvent);
      const event = (await repo.findOne({ where: { id: rows[0].id } }))!;

      if (now.getTime() - event.occurredAt.getTime() > MAX_EVENT_AGE_MS) {
        await repo.update(event.id, { deliveryState: 'failed', lastError: EXPIRED_ERROR, nextAttemptAt: null });
        return 'failed';
      }

      let outcome: HandlerOutcome;
      // A savepoint, so a handler whose own query failed leaves this transaction usable
      // for recording the retry; without it Postgres refuses every statement after the
      // error and the attempt would go unrecorded.
      await m.query('SAVEPOINT outbox_handler');
      try {
        outcome = await this.handlers.get(event.eventType)!.handle(m, event, now);
        await m.query('RELEASE SAVEPOINT outbox_handler');
      } catch (err) {
        await m.query('ROLLBACK TO SAVEPOINT outbox_handler');
        // A handler that throws has not decided anything; treat it as worth retrying, and
        // say why on the row rather than only in a log.
        outcome = { kind: 'retry', error: err instanceof Error ? err.message : String(err) };
      }

      if (outcome.kind === 'delivered') {
        await repo.update(event.id, { deliveryState: 'delivered', deliveredAt: now, lastError: null, nextAttemptAt: null });
        return 'delivered';
      }
      const attempts = event.attempts + 1;
      if (outcome.kind === 'failed' || attempts >= MAX_ATTEMPTS) {
        await repo.update(event.id, { deliveryState: 'failed', attempts, lastError: outcome.error, nextAttemptAt: null });
        this.logger.warn(`${event.eventType} ${event.id} failed: ${outcome.error}`);
        return 'failed';
      }
      const wait = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] * 60_000;
      await repo.update(event.id, {
        attempts, lastError: outcome.error, nextAttemptAt: new Date(now.getTime() + wait),
      });
      return 'retried';
    });
  }
}
