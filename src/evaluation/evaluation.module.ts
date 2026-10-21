import { Module } from '@nestjs/common';
import { ForecastModule } from '../forecast/forecast.module';
import { FORECAST_WORKER, workerCommandFromEnv } from '../forecast/forecast-worker';
import { EvaluationService } from './evaluation.service';

/**
 * Evaluation (task QEVAL1a). In the application root only because every module is (the
 * wiring guard); it holds no controller and no timer, so nothing runs an evaluation but
 * `eval-main` — it is something a person runs and reads (Q6). The worker command is the
 * forecast pass's own, from the same environment.
 */
@Module({
  imports: [ForecastModule],
  providers: [
    EvaluationService,
    { provide: FORECAST_WORKER, useFactory: () => workerCommandFromEnv(process.env) },
  ],
  exports: [EvaluationService],
})
export class EvaluationModule {}
