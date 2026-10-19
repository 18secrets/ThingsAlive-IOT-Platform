import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_FORECAST_TICK_SECONDS } from './forecast-reader';

/**
 * Starts the forecast pass from the scheduler process, on the pattern of `ShiftScheduler`
 * — and off unless FORECAST_ENABLED=true. Setting that on Railway is not part of QML1
 * (CLAUDE.md: a variable on an existing service is Deepak's).
 *
 * Each tick runs `node dist/forecast-main.js --once` as a child and waits for it (D41):
 * the pass shares no memory with this process, so the model it loads is released when
 * the child exits, and moving it to its own service later changes a start command, not
 * code. `running` stops this process overlapping itself; the pass's advisory lock stops
 * two processes overlapping each other.
 */
@Injectable()
export class ForecastScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForecastScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  onModuleInit(): void {
    if (`${process.env.FORECAST_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('FORECAST_ENABLED is not true, so no forecast pass is started by this process.');
      return;
    }
    const seconds = Math.max(60, Number(process.env.FORECAST_TICK_SECONDS ?? DEFAULT_FORECAST_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Forecast pass every ${seconds}s, in its own process.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [join(__dirname, '..', 'forecast-main.js'), '--once'], { stdio: 'inherit' });
        child.on('close', resolve);
        child.on('error', () => resolve(-1));
      });
      if (code !== 0) this.logger.warn(`forecast pass exited ${code}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ providers: [ForecastScheduler] })
export class ForecastSchedulingModule {}
