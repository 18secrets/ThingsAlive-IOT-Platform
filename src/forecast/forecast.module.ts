import { Module } from '@nestjs/common';
import { KpiModule } from '../kpi/kpi.module';
import { ForecastReader } from './forecast-reader';
import { ForecastService } from './forecast.service';
import { ForecastWarmStart } from './forecast-warm-start';
import { FORECAST_WORKER, workerCommandFromEnv } from './forecast-worker';

/**
 * Forecasting (task QML1): the pass and what the page reads. No timer here — that is
 * `ForecastSchedulingModule`, imported only by the app — so `forecast-main`, which boots
 * this module on its own, can never start a second scheduler inside the child it is.
 */
@Module({
  imports: [KpiModule],
  providers: [
    ForecastReader,
    ForecastService,
    ForecastWarmStart,
    { provide: FORECAST_WORKER, useFactory: () => workerCommandFromEnv(process.env) },
  ],
  exports: [ForecastReader, ForecastService, ForecastWarmStart],
})
export class ForecastModule {}
