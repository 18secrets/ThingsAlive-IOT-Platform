import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxConsumer } from '../events/outbox-consumer';

export const DEFAULT_TICK_SECONDS = 30;

/**
 * Drains the outbox on the pattern of `IncidentEscalationScheduler`, and off unless
 * INCIDENT_NOTIFY_ENABLED=true, for its reason: a job that starts itself everywhere
 * runs in tests and against databases it has no business touching. Set it on the
 * scheduler service, beside INCIDENT_ESCALATION_ENABLED — the sweep writes the event,
 * this sends it. Running it on two processes is safe (SKIP LOCKED), just pointless.
 */
@Injectable()
export class IncidentNotifyScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncidentNotifyScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly consumer: OutboxConsumer) {}

  onModuleInit(): void {
    if (`${process.env.INCIDENT_NOTIFY_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('INCIDENT_NOTIFY_ENABLED is not true, so escalations are not sent by this process.');
      return;
    }
    const seconds = Math.max(10, Number(process.env.INCIDENT_NOTIFY_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Outbox pass every ${seconds}s for ${this.consumer.handledTypes.join(', ')}.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.consumer.pass(now);
      if (r.delivered || r.retried || r.failed) this.logger.log(`Outbox: ${JSON.stringify(r)}.`);
    } catch (err) {
      this.logger.error(`Outbox pass failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
