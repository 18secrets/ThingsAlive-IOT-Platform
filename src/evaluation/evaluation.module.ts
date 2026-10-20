import { Module } from '@nestjs/common';
import { DEFAULT_MODEL_DIR, EMBEDDING_RUNTIME, OnnxEmbeddingRuntime } from '../embedding/embedder';
import { ForecastModule } from '../forecast/forecast.module';
import { FORECAST_WORKER, workerCommandFromEnv } from '../forecast/forecast-worker';
import { EvaluationService } from './evaluation.service';
import { RetrievalEvalService } from './retrieval-eval.service';

/**
 * Evaluation (tasks QEVAL1a and QEVAL1b). In the application root only because every module is (the
 * wiring guard); it holds no controller and no timer, so nothing runs an evaluation but
 * `eval-main` — it is something a person runs and reads (Q6). The worker command is the
 * forecast pass's own, and the embedding runtime the api's, each from the same
 * environment, so what is evaluated is what runs.
 */
@Module({
  imports: [ForecastModule],
  providers: [
    EvaluationService,
    RetrievalEvalService,
    { provide: FORECAST_WORKER, useFactory: () => workerCommandFromEnv(process.env) },
    {
      provide: EMBEDDING_RUNTIME,
      useFactory: () => new OnnxEmbeddingRuntime(process.env.EMBEDDING_MODEL_DIR?.trim() || DEFAULT_MODEL_DIR),
    },
  ],
  exports: [EvaluationService, RetrievalEvalService],
})
export class EvaluationModule {}
