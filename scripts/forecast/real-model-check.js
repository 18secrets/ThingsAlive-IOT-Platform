// The real-model check for QML1 (Q15: run locally, not in CI yet). Run inside the
// scheduler image, with this file mounted:
//
//   docker run --rm -v "$PWD/scripts/forecast/real-model-check.js:/check.js:ro" \
//     <scheduler image> node /check.js
//
// It goes through the same runWorker and response validator the pass uses, so a
// worker that answers in a shape the pass would refuse fails here too. Synthetic input
// of the model's own context length: the point is the runtime, not forecast quality.
const { runWorker, workerCommandFromEnv } = require('/app/dist/forecast/forecast-worker.js');

const model = { key: 'granite-timeseries-ttm-r2', revision: process.env.TTM_REVISION };
const series = (n) => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`, stepSeconds: 3600, start: '2026-09-27T14:00:00.000Z',
  values: Array.from({ length: 512 }, (_, t) => 80 + 2 * Math.sin((t + i) * 2 * Math.PI / 24) + (i % 7) * 0.1),
}));

(async () => {
  const cmd = workerCommandFromEnv(process.env);
  for (const n of [1, 1000]) {
    const t = Date.now();
    const res = await runWorker(cmd, { contract: 'forecast-request.v1', model, contextLength: 512, predictionLength: 96, series: series(n) }, 600_000);
    const first = res.series[0].values;
    console.log(JSON.stringify({
      series: n, answered: res.series.length, refused: res.refused.length, weightsSha256: res.model.weightsSha256,
      loadSeconds: res.timing.loadSeconds, inferSeconds: res.timing.inferSeconds, wallSeconds: (Date.now() - t) / 1000,
      firstStep: Number(first[0].toFixed(3)), stepsReturned: first.length,
    }));
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
