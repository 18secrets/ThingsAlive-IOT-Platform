import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IncidentRecordService } from './incident-record.service';

export const DEFAULT_TICK_SECONDS = 60;

/**
 * Runs the escalation sweep on the same pattern as `ShiftScheduler` and
 * `TelemetryPartitionScheduler` — one scheduling mechanism in this codebase. Off by
 * default, for their reason: a job that starts itself everywhere runs in tests and
 * against databases it has no business touching. The scheduler service sets
 * INCIDENT_ESCALATION_ENABLED=true.
 */
@Injectable()
export class IncidentEscalationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncidentEscalationScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly incidents: IncidentRecordService) {}

  onModuleInit(): void {
    if (`${process.env.INCIDENT_ESCALATION_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('INCIDENT_ESCALATION_ENABLED is not true, so overdue incidents are not escalated by this process.');
      return;
    }
    const seconds = Math.max(15, Number(process.env.INCIDENT_ESCALATION_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Incident escalation sweep every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.incidents.escalateOverdue(now);
    } catch (err) {
      this.logger.error(`Escalation sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
