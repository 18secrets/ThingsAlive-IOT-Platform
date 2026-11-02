import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ShiftFuelService } from './shift-fuel.service';

/** Hourly. The existing platform totals a shift once, after it ends, and revises it later. */
export const DEFAULT_SHIFT_FUEL_TICK_SECONDS = 3_600;

/**
 * The shift fuel sync and forecast on a timer, on the pattern of `ShiftScheduler` — and off
 * unless SHIFT_FUEL_FORECAST_ENABLED=true *and* LEGACY_SHIFT_DB_* is configured (D50). Set
 * both on the scheduler service only: the pass takes an advisory lock, so a second process
 * is harmless, but it would read the far database twice for one answer.
 *
 * Hourly is a latency, not a frequency: it is the longest a newly totalled shift waits
 * before the next forecast is made from it. A pass over unchanged data writes nothing.
 */
@Injectable()
export class ShiftFuelScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftFuelScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly fuel: ShiftFuelService) {}

  onModuleInit(): void {
    if (`${process.env.SHIFT_FUEL_FORECAST_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('SHIFT_FUEL_FORECAST_ENABLED is not true, so shift fuel is not synced or forecast by this process.');
      return;
    }
    if (!this.fuel.configured) {
      // Enabled with nowhere to read from is a configuration mistake, and saying so at
      // boot is cheaper than an hourly pass that has nothing to do.
      this.logger.warn('SHIFT_FUEL_FORECAST_ENABLED is true but LEGACY_SHIFT_DB_* is not set; nothing is scheduled.');
      return;
    }
    const seconds = Math.max(300, Number(process.env.SHIFT_FUEL_FORECAST_TICK_SECONDS ?? DEFAULT_SHIFT_FUEL_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Shift fuel sync and forecast every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.fuel.run(now);
      if (!s) return;
      this.logger.log(
        `Shift fuel: ${s.machines} machine(s), ${s.read} row(s) read, ${s.inserted} new, ${s.revised} revised, `
        + `${s.invalid} refused, ${s.forecastsIssued} forecast(s) issued.`,
      );
    } catch (error) {
      // A timer whose callback throws reports nothing and the job stops silently. Caught,
      // logged, and the next tick tries again — including a far database that was down.
      this.logger.error(`Shift fuel pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
