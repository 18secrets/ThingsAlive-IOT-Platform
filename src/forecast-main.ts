import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './database/data-source';
import { ForecastModule } from './forecast/forecast.module';
import { ForecastService } from './forecast/forecast.service';
import { ForecastWarmStart } from './forecast/forecast-warm-start';
import { DEFAULT_FORECAST_TICK_SECONDS } from './forecast/forecast-reader';

/**
 * The forecast pass's own process (D41's `dist/forecast-main.js`). A Nest application
 * context — no HTTP — holding the database and the forecast module and nothing else; it
 * talks to the rest of the platform only through the database.
 *
 *   --once   one pass, then exit (what ForecastScheduler runs each tick)
 *   --loop   its own timer, for the day forecasting is its own Railway service
 *
 * Exit code 1 when the pass failed, so a supervisor sees it without reading the ledger.
 */
@Module({
  imports: [TypeOrmModule.forRoot({ ...dataSourceOptions(), retryAttempts: 0 }), ForecastModule],
})
class ForecastMainModule {}

async function main(argv: string[]): Promise<void> {
  const logger = new Logger('ForecastMain');
  const app = await NestFactory.createApplicationContext(ForecastMainModule, { logger: ['log', 'warn', 'error'] });
  const pass = app.get(ForecastService);
  const warm = app.get(ForecastWarmStart);
  // After the pass, never instead of it: replaying history is owed once per signal, and a
  // pass that waited on it would let today's forecasts go stale for last month's.
  const warmStart = async () => {
    const w = await warm.run();
    if (w.runId) {
      logger.log(`warm start ${w.runId}: ${w.outcome}, ${w.warmed} signals replayed (${w.residuals} residuals), `
        + `${w.noHistory} with too little history${w.error ? ` (${w.error})` : ''}`);
    }
  };
  if (argv.includes('--loop')) {
    const seconds = Math.max(60, Number(process.env.FORECAST_TICK_SECONDS ?? DEFAULT_FORECAST_TICK_SECONDS));
    const tick = async () => {
      const s = await pass.runPass();
      logger.log(`pass ${s.runId}: ${s.outcome}, ${s.forecast} forecast, ${s.skipped} skipped`);
      await warmStart();
    };
    await tick();
    setInterval(() => void tick(), seconds * 1000);
    return;
  }
  const s = await pass.runPass();
  logger.log(`pass ${s.runId}: ${s.outcome}, ${s.considered} considered, ${s.forecast} forecast, ${s.skipped} skipped${s.error ? ` (${s.error})` : ''}`);
  await warmStart();
  await app.close();
  process.exit(s.outcome === 'failed' ? 1 : 0);
}

void main(process.argv.slice(2)).catch((err) => {
  new Logger('ForecastMain').error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
