import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { VaniCallSender } from './vani-call-sender';

export const DEFAULT_TICK_SECONDS = 15;

/**
 * Runs `VaniCallSender` on the pattern of `IncidentNotifyScheduler`, and off unless
 * VANI_CALLS_ENABLED=true, for the same reason: a job that starts itself everywhere runs
 * in tests and on laptops, and this one phones real people. Set it on the scheduler
 * service only. Two processes running it is safe (SKIP LOCKED), just pointless.
 */
@Injectable()
export class VaniCallScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VaniCallScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly sender: VaniCallSender) {}

  onModuleInit(): void {
    if (`${process.env.VANI_CALLS_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('VANI_CALLS_ENABLED is not true, so this process does not send Vani calls.');
      return;
    }
    const seconds = Math.max(5, Number(process.env.VANI_CALLS_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Vani call pass every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.sender.pass(now);
      if (r.accepted || r.rejected || r.retried || r.failed) this.logger.log(`Vani calls: ${JSON.stringify(r)}.`);
    } catch (err) {
      this.logger.error(`Vani call pass failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
