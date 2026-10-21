import { Module } from '@nestjs/common';
import { ForecastModule } from '../forecast/forecast.module';
import { FORECAST_WORKER, workerCommandFromEnv } from '../forecast/forecast-worker';
import { RecEngineModule } from '../rec-engine/rec-engine.module';
import { EvaluationService } from './evaluation.service';
import { RecommendationReplayService } from './recommendation-replay.service';

/**
 * Evaluation (tasks QEVAL1a and QEVAL1c). In the application root only because every module is (the
 * wiring guard); it holds no controller and no timer, so nothing runs an evaluation but
 * `eval-main` — it is something a person runs and reads (Q6). The worker command is the
 * forecast pass's own, from the same environment.
 */
@Module({
  imports: [ForecastModule, RecEngineModule],
  providers: [
    EvaluationService,
    RecommendationReplayService,
    { provide: FORECAST_WORKER, useFactory: () => workerCommandFromEnv(process.env) },
  ],
  exports: [EvaluationService, RecommendationReplayService],
})
export class EvaluationModule {}
