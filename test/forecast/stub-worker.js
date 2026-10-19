// A deterministic stand-in for python/forecast/infer.py, speaking the same contract, so
// test:db needs no torch (QML1 section 11). Each forecast is the series' last context
// value plus STUB_SLOPE per step. STUB_MODE picks a failure; STUB_RECORD, if set, is a
// file the request is written to, so a test can assert what the worker was sent.
const fs = require('node:fs');

const SHA = 'a706726a7eb01bbcb42994b7dcb3c06ea9557898dbae8d480eb04fe8ccb89710';
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (process.env.STUB_RECORD) fs.writeFileSync(process.env.STUB_RECORD, input);
  const mode = process.env.STUB_MODE || 'ok';
  const slope = Number(process.env.STUB_SLOPE || 0);
  const refuse = new Set((process.env.STUB_REFUSE || '').split(',').filter(Boolean));
  if (mode === 'crash') {
    process.stdout.write('{"contract":"forecast-response.v1","series":[');
    process.stderr.write('Segmentation fault in the stub\n');
    process.exit(3);
  }
  const series = [];
  const refused = [];
  for (const s of req.series) {
    if (refuse.has(s.id)) { refused.push({ id: s.id, reason: 'stub refused' }); continue; }
    const last = s.values[s.values.length - 1];
    let values = Array.from({ length: req.predictionLength }, (_, i) => last + slope * (i + 1));
    if (mode === 'nan') values[3] = Number.NaN;
    if (mode === 'short') values = values.slice(1);
    series.push({ id: s.id, values });
  }
  const model = {
    key: req.model.key,
    revision: mode === 'mismatch' ? '0000000000000000000000000000000000000000' : req.model.revision,
    weightsSha256: mode === 'weights' ? 'f'.repeat(64) : SHA,
  };
  if (mode === 'malformed') { process.stdout.write('not json at all'); return; }
  // JSON.stringify turns NaN into null, which the validator refuses as non-finite.
  process.stdout.write(JSON.stringify({ contract: 'forecast-response.v1', model, series, refused, timing: { loadSeconds: 0.01, inferSeconds: 0.001 } }));
});
