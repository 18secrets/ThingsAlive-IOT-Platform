import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TelemetryPartitionMaintenance } from './telemetry-partition-maintenance.service';

/** A daily pass is a daily pass; this is how often it is attempted, not how far ahead it looks. */
export const DEFAULT_TICK_SECONDS = 86_400;

/**
 * The thing that makes partition maintenance happen without somebody asking, on the
 * same pattern as `ShiftScheduler` (task QPART1) — one scheduling mechanism in this
 * codebase, not two.
 *
 * `setInterval` rather than a cron expression, for the same reason `ShiftScheduler`
 * uses one: there is nothing here that needs an hour of day, only a "not too often".
 *
 * Off by default. A scheduled job that starts itself in every environment is a
 * scheduled job that runs during somebody's migration, in a test, and on a
 * developer's laptop pointed at a database it has no business touching.
 */
@Injectable()
export class TelemetryPartitionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryPartitionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly maintenance: TelemetryPartitionMaintenance) {}

  onModuleInit(): void {
    if (`${process.env.TELEMETRY_PARTITION_MAINTENANCE_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log(
        'TELEMETRY_PARTITION_MAINTENANCE_ENABLED is not true, so nothing is scheduled. '
        + "The migration's own 12-month buffer still holds.",
      );
      return;
    }
    const seconds = Math.max(
      30, Number(process.env.TELEMETRY_PARTITION_MAINTENANCE_TICK_SECONDS ?? DEFAULT_TICK_SECONDS),
    );
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // Node keeps the process alive for a pending timer, which would hold a container
    // open through a shutdown that is otherwise complete.
    this.timer.unref?.();
    this.logger.log(`Partition maintenance pass every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous pass still running. Skipping this tick.');
      return;
    }
    this.running = true;
    try {
      await this.maintenance.run(now);
    } finally {
      this.running = false;
    }
  }
}
