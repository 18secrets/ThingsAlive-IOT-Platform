import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { writeFileSync } from 'node:fs';
import { dataSourceOptions } from './database/data-source';
import { EvaluationModule } from './evaluation/evaluation.module';
import { EvalSummary, EvaluationService } from './evaluation/evaluation.service';
import { GoldenSetInvalid, loadGoldenSet } from './evaluation/retrieval-golden';
import { RetrievalEvalService } from './evaluation/retrieval-eval.service';
import { RecommendationReplayService } from './evaluation/recommendation-replay.service';

/**
 * The evaluation CLI (QEVAL1 §6). No HTTP: results are read from the summary it prints,
 * the file it writes, or the tables (Q6).
 *
 *   npm run eval -- --kind ttm_backtest --dataset seeded|real
 *                   [--from 2026-09-01] [--to 2026-10-20] [--replay-days 7]
 *                   [--model <forecast_model id>] [--budget-seconds 900] [--budget-series 5000]
 *                   [--note "…"] [--out summary.json]
 *   npm run eval -- --kind retrieval --dataset seeded|real --golden <file>
 *                   [--tenant a,b] [--budget-seconds 900] [--budget-series 5000]
 *                   [--note "…"] [--out summary.json]
 *   npm run eval -- --kind recommendation_replay --dataset seeded|real
 *                   [--from …] [--to …] [--moments-per-machine 200]
 *                   [--budget-seconds 900] [--budget-series 5000] [--note "…"] [--out summary.json]
 *
 * A retrieval golden set's format is in docs/ai/eval/retrieval/README.md. A smoke set is
 * labelled seeded whatever it was told.
 *
 * `--dataset` is required rather than defaulted: which data a number came from is the
 * first thing anyone reading it needs, and a default would be a guess (§5). A run over
 * simulated telemetry is labelled seeded whatever it was told.
 *
 * Exit codes: 0 completed, 1 failed (including a retrieval isolation breach), 2 a kind
 * that cannot run yet or bad arguments,
 * 3 another run of the kind holds the lock, 4 budget exhausted.
 */
@Module({
  imports: [TypeOrmModule.forRoot({ ...dataSourceOptions(), retryAttempts: 0 }), EvaluationModule],
})
class EvalMainModule {}

const NOT_YET: Record<string, string> = {};

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const logger = new Logger('EvalMain');
  const kind = arg(argv, 'kind');
  if (kind && NOT_YET[kind]) { logger.error(`${kind} cannot run yet. ${NOT_YET[kind]}`); return 2; }
  if (kind !== 'ttm_backtest' && kind !== 'retrieval' && kind !== 'recommendation_replay') {
    logger.error('--kind ttm_backtest|retrieval|recommendation_replay');
    return 2;
  }
  const dataset = arg(argv, 'dataset');
  if (dataset !== 'seeded' && dataset !== 'real') { logger.error('--dataset seeded|real is required'); return 2; }
  const date = (s?: string) => (s ? new Date(s) : undefined);
  const num = (s?: string) => (s === undefined ? undefined : Number(s));
  let golden: ReturnType<typeof loadGoldenSet> | undefined;
  if (kind === 'retrieval') {
    const path = arg(argv, 'golden');
    if (!path) { logger.error('--golden <file> is required for retrieval (docs/ai/eval/retrieval/README.md)'); return 2; }
    try {
      golden = loadGoldenSet(path);
    } catch (err) {
      if (err instanceof GoldenSetInvalid || (err as NodeJS.ErrnoException).code === 'ENOENT') { logger.error((err as Error).message); return 2; }
      throw err;
    }
  }

  const app = await NestFactory.createApplicationContext(EvalMainModule, { logger: ['log', 'warn', 'error'] });
  try {
    const common = {
      dataset, datasetNote: arg(argv, 'note'), from: date(arg(argv, 'from')), to: date(arg(argv, 'to')),
      budgetSeconds: num(arg(argv, 'budget-seconds')), budgetSeries: num(arg(argv, 'budget-series')),
    } as const;
    const s: EvalSummary = kind === 'retrieval'
      ? await app.get(RetrievalEvalService).runRetrieval({
        dataset, datasetNote: arg(argv, 'note'), golden: golden!.set, goldenSha256: golden!.sha256,
        tenants: arg(argv, 'tenant')?.split(',').map((t) => t.trim()).filter(Boolean),
        budgetSeconds: num(arg(argv, 'budget-seconds')), budgetPairs: num(arg(argv, 'budget-series')),
      })
      : kind === 'recommendation_replay'
      ? await app.get(RecommendationReplayService).run({ ...common, momentsPerMachine: num(arg(argv, 'moments-per-machine')) })
      : await app.get(EvaluationService).runBacktest({
        ...common, modelId: arg(argv, 'model'), replayDays: num(arg(argv, 'replay-days')),
      });
    const text = JSON.stringify(s, null, 2);
    const out = arg(argv, 'out');
    if (out) writeFileSync(out, `${text}\n`, 'utf8');
    process.stdout.write(`${text}\n`);
    return { completed: 0, failed: 1, lock_held: 3, budget_exhausted: 4, running: 1 }[s.status];
  } finally {
    await app.close();
  }
}

void main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  new Logger('EvalMain').error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
