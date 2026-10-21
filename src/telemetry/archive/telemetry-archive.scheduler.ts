import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TelemetryArchiveService } from './telemetry-archive.service';

export const DEFAULT_TICK_SECONDS = 86_400;

/**
 * Daily archive pass, on the pattern of `TelemetryPartitionScheduler` — and off unless
 * TELEMETRY_ARCHIVE_ENABLED=true, for its reason. Set on the scheduler service only,
 * beside the partition maintenance it is the other half of.
 */
@Injectable()
export class TelemetryArchiveScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryArchiveScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly archive: TelemetryArchiveService) {}

  onModuleInit(): void {
    if (`${process.env.TELEMETRY_ARCHIVE_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('TELEMETRY_ARCHIVE_ENABLED is not true, so telemetry past 90 days is not archived by this process.');
      return;
    }
    const seconds = Math.max(60, Number(process.env.TELEMETRY_ARCHIVE_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Telemetry archive pass every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.archive.run(now);
    } catch (err) {
      this.logger.error(`Archive pass failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
