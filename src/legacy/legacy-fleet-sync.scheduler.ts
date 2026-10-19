import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LegacyFleetSyncService } from './legacy-fleet-sync.service';

export const DEFAULT_TICK_SECONDS = 86_400;

/**
 * The 1.0 fleet sync on a timer, on the pattern of `TelemetryArchiveScheduler` — and
 * off unless LEGACY_FLEET_SYNC_ENABLED=true. Daily by default: machines and loggers
 * change on the scale of days, and each pass is a full read of 1.0's fleet tables.
 * Set it on the scheduler service only; two processes running full reconciles against
 * each other gain nothing.
 */
@Injectable()
export class LegacyFleetSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LegacyFleetSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly sync: LegacyFleetSyncService) {}

  onModuleInit(): void {
    if (`${process.env.LEGACY_FLEET_SYNC_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('LEGACY_FLEET_SYNC_ENABLED is not true, so the 1.0 fleet is not mirrored by this process.');
      return;
    }
    const seconds = Math.max(300, Number(process.env.LEGACY_FLEET_SYNC_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`1.0 fleet sync every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.sync.run({}, now);
      this.logger.log(`1.0 fleet sync: ${JSON.stringify(r.applied)}; invalid ${JSON.stringify(r.invalid)}.`);
    } catch (err) {
      this.logger.error(`1.0 fleet sync failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
