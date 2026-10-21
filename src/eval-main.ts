import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { writeFileSync } from 'node:fs';
import { dataSourceOptions } from './database/data-source';
import { EvaluationModule } from './evaluation/evaluation.module';
import { EvaluationService } from './evaluation/evaluation.service';

/**
 * The evaluation CLI (QEVAL1 §6). No HTTP: results are read from the summary it prints,
 * the file it writes, or the tables (Q6).
 *
 *   npm run eval -- --kind ttm_backtest --dataset seeded|real
 *                   [--from 2026-09-01] [--to 2026-10-20] [--replay-days 7]
 *                   [--model <forecast_model id>] [--budget-seconds 900] [--budget-series 5000]
 *                   [--note "…"] [--out summary.json]
 *
 * `--dataset` is required rather than defaulted: which data a number came from is the
 * first thing anyone reading it needs, and a default would be a guess (§5). A run over
 * simulated telemetry is labelled seeded whatever it was told.
 *
 * Exit codes: 0 completed, 1 failed, 2 a kind that cannot run yet or bad arguments,
 * 3 another run of the kind holds the lock, 4 budget exhausted.
 */
@Module({
  imports: [TypeOrmModule.forRoot({ ...dataSourceOptions(), retryAttempts: 0 }), EvaluationModule],
})
class EvalMainModule {}

const NOT_YET: Record<string, string> = {
  retrieval: 'QEVAL1b: waits on QEMB1 (pgvector on Railway) and a golden set authored by domain experts',
  recommendation_replay: 'QEVAL1c: waits on QREC2 (the deterministic renderer)',
};

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const logger = new Logger('EvalMain');
  const kind = arg(argv, 'kind');
  if (kind && NOT_YET[kind]) { logger.error(`${kind} cannot run yet. ${NOT_YET[kind]}`); return 2; }
  if (kind !== 'ttm_backtest') { logger.error('--kind ttm_backtest is the only kind available'); return 2; }
  const dataset = arg(argv, 'dataset');
  if (dataset !== 'seeded' && dataset !== 'real') { logger.error('--dataset seeded|real is required'); return 2; }
  const date = (s?: string) => (s ? new Date(s) : undefined);
  const num = (s?: string) => (s === undefined ? undefined : Number(s));

  const app = await NestFactory.createApplicationContext(EvalMainModule, { logger: ['log', 'warn', 'error'] });
  try {
    const s = await app.get(EvaluationService).runBacktest({
      dataset, datasetNote: arg(argv, 'note'), modelId: arg(argv, 'model'),
      from: date(arg(argv, 'from')), to: date(arg(argv, 'to')), replayDays: num(arg(argv, 'replay-days')),
      budgetSeconds: num(arg(argv, 'budget-seconds')), budgetSeries: num(arg(argv, 'budget-series')),
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
