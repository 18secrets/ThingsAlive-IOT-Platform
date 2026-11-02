import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DEFAULT_NOWCAST_TICK_SECONDS } from './shift-fuel-nowcast';
import { ShiftFuelNowcastService } from './shift-fuel-nowcast.service';

/** Shortest tick allowed: every tick probes the existing platform's live log table. */
export const MIN_NOWCAST_TICK_SECONDS = 300;

/** The tick from the environment: the default when unset or not a number, never under the floor. */
export function nowcastTickSeconds(env: Record<string, string | undefined>): number {
  const asked = Number(env.SHIFT_FUEL_NOWCAST_TICK_SECONDS ?? DEFAULT_NOWCAST_TICK_SECONDS);
  // NaN would reach setInterval as a delay of 1 ms: a typo would become a probe loop
  // against somebody else's production database.
  return Number.isFinite(asked) ? Math.max(MIN_NOWCAST_TICK_SECONDS, asked) : DEFAULT_NOWCAST_TICK_SECONDS;
}

/**
 * The in-shift nowcast (D52) on a timer, every quarter hour by default, on the pattern of
 * D50's `ShiftFuelScheduler`.
 *
 * Off unless all three hold: SHIFT_FUEL_FORECAST_ENABLED=true, SHIFT_FUEL_NOWCAST_ENABLED=true
 * and LEGACY_SHIFT_DB_* configured. Its own flag on top of D50's because it reads more than
 * D50 was switched on for: D50's grant is one small table, and this probes the existing
 * platform's raw log table and five mapping tables every quarter hour. Turning that on
 * should be somebody deciding to once those grants exist, not a side effect of a deploy
 * landing on a scheduler that already had the forecast enabled — which, without the
 * grants, would also be a permission error in the log every fifteen minutes.
 */
@Injectable()
export class ShiftFuelNowcastScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftFuelNowcastScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private seconds = DEFAULT_NOWCAST_TICK_SECONDS;

  constructor(private readonly nowcast: ShiftFuelNowcastService) {}

  onModuleInit(): void {
    const on = (name: string) => `${process.env[name] ?? ''}`.toLowerCase() === 'true';
    if (!on('SHIFT_FUEL_FORECAST_ENABLED') || !on('SHIFT_FUEL_NOWCAST_ENABLED')) {
      this.logger.log('SHIFT_FUEL_FORECAST_ENABLED and SHIFT_FUEL_NOWCAST_ENABLED are not both true, so no shift fuel nowcast runs in this process.');
      return;
    }
    if (!this.nowcast.configured) {
      this.logger.warn('The shift fuel nowcast is enabled but LEGACY_SHIFT_DB_* is not set; nothing is scheduled.');
      return;
    }
    this.seconds = nowcastTickSeconds(process.env);
    this.timer = setInterval(() => void this.tick(), this.seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Shift fuel nowcast every ${this.seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.nowcast.run(now, this.seconds);
      if (!s) return;
      this.logger.log(
        `Shift fuel nowcast as of ${s.asOf} (${s.sdate} shift ${s.shift}): ${s.machines} machine(s), ${s.issued} snapshot(s), `
        + `${s.silent} silent, ${s.unmapped} without a fuel counter, ${s.stale} stale.`,
      );
    } catch (error) {
      // Caught and logged so the timer survives; the next tick tries again.
      this.logger.error(`Shift fuel nowcast pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
