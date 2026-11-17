import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MotorIngestService } from './motor-ingest.service';

export const DEFAULT_MOTOR_TICK_SECONDS = 30;

/**
 * Picks up what the motor logger receiver stored, every thirty seconds by default.
 *
 * Runs where the shift runner runs, unless told otherwise: MOTOR_TELEMETRY_ENABLED=true
 * or false decides, and unset it follows SHIFT_RUNNER_ENABLED. The shift runner scores
 * the telemetry this job writes, so wherever one is wanted the other is, and enabling
 * motors needs no new switch. Off in tests and on a laptop for the same reason the
 * shift runner is (see ShiftScheduler).
 *
 * Two guards, as there: `running` keeps one instance from overlapping itself, and the
 * advisory lock in `processExclusively` keeps the API and the scheduler service from
 * doing the same pass twice.
 */
@Injectable()
export class MotorTelemetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MotorTelemetryScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly motors: MotorIngestService) {}

  onModuleInit(): void {
    const own = `${process.env.MOTOR_TELEMETRY_ENABLED ?? ''}`.toLowerCase();
    const enabled = own ? own === 'true' : `${process.env.SHIFT_RUNNER_ENABLED ?? ''}`.toLowerCase() === 'true';
    if (!enabled) {
      this.logger.log('Motor telemetry job off (MOTOR_TELEMETRY_ENABLED, else SHIFT_RUNNER_ENABLED). Readings wait in motor_sensor_records.');
      return;
    }
    const seconds = Math.max(10, Number(process.env.MOTOR_TELEMETRY_TICK_SECONDS ?? DEFAULT_MOTOR_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Motor telemetry pass every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.motors.processExclusively(now);
    } catch (error) {
      // Caught and logged so the timer keeps running: the rows stay queued for the next tick.
      this.logger.error(`Motor telemetry pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
