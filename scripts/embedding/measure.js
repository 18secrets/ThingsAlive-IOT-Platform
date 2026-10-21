// QEMB1's measurements (docs/ai/measurements/QEMB1.md): every number there is printed
// by this script, nothing is copied by hand.
//
//   node scripts/embedding/measure.js <model dir>
//
// with DB_HOST, DB_USERNAME, DB_DATABASE pointing at a migrated, disposable test database
// (its name must contain "test": it writes, then deletes, a throwaway tenant's rows).
//
// 1. Embedding throughput of the real model, batch 1 and 16, after one warm-up call.
// 2. Brute-force search latency through library_embedding_nearest, as `ta_app` under the
//    tenant's session exactly as the service runs it, at 1k, 10k and 50k vectors in one
//    tenant. Random unit vectors: the cost of an exhaustive scan does not depend on what
//    the vectors mean.
const { Client } = require('pg');
const { join } = require('node:path');

const TENANT = 'qemb1-measure';
const DIM = 384;
const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD ?? '', database: process.env.DB_DATABASE };
if (!/test/i.test(db.database ?? '')) throw new Error(`refusing to write to "${db.database}": not a test database`);

const unit = () => {
  const v = Array.from({ length: DIM }, () => Math.random() - 0.5);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

async function throughput(modelDir) {
  const tf = require('@huggingface/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.localModelPath = modelDir;
  const t0 = Date.now();
  const extract = await tf.pipeline('feature-extraction', 'BAAI/bge-small-en-v1.5', { dtype: 'fp32', device: 'cpu' });
  console.log(`model load: ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  const docs = Array.from({ length: 128 }, (_, i) =>
    `Failure mode: Oil cooler blocked (COOLER-${i}). Equipment class: excavator. Symptom: Hydraulic oil temperature climbs under load. Signals: hydraulic_oil_temp.`);
  await extract(docs.slice(0, 4), { pooling: 'cls', normalize: true });
  for (const batch of [1, 16]) {
    const t = Date.now();
    for (let i = 0; i < docs.length; i += batch) await extract(docs.slice(i, i + batch), { pooling: 'cls', normalize: true });
    console.log(`embedding, batch ${batch}: ${(docs.length / ((Date.now() - t) / 1000)).toFixed(1)} docs/sec over ${docs.length} docs`);
  }
  console.log(`rss after embedding: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
}

async function search() {
  const c = new Client(db);
  await c.connect();
  const [{ id: profile }] = (await c.query(`SELECT id FROM embedding_profile WHERE status = 'active'`)).rows;
  const clean = () => c.query(`DELETE FROM client_equipment_class_failure_mode WHERE tenant_id = $1`, [TENANT]);
  await clean();
  let have = 0;
  try {
    for (const n of [1000, 10000, 50000]) {
      for (; have < n; have += 1000) {
        const ids = (await c.query(
          `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name)
           SELECT $1, 'measure', 'M-' || g, 'mode ' || g FROM generate_series($2::int, $2::int + 999) g RETURNING id`,
          [TENANT, have])).rows.map((r) => r.id);
        const vectors = ids.map(() => `{${unit().join(',')}}`);
        await c.query(
          `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, input_hash, vector)
           SELECT $1, $2, 'failure_mode', u.id, repeat('a', 64), u.v::real[] FROM unnest($3::uuid[], $4::text[]) AS u(id, v)`,
          [TENANT, profile, ids, vectors]);
      }
      await c.query('ANALYZE library_embedding');
      const times = [];
      for (let i = 0; i < 22; i++) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ta.tenant_id', $1, true)`, [TENANT]);
        await c.query('SET LOCAL ROLE ta_app');
        const t = process.hrtime.bigint();
        const r = await c.query(`SELECT * FROM library_embedding_nearest($1, $2::real[], 30)`, [profile, `{${unit().join(',')}}`]);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        await c.query('COMMIT');
        if (r.rowCount !== 30) throw new Error(`expected 30 hits, got ${r.rowCount}`);
        if (i >= 2) times.push(ms); // the first two warm the cache
      }
      console.log(`search, ${n} vectors, top 30: median ${pct(times, 0.5).toFixed(1)} ms, p95 ${pct(times, 0.95).toFixed(1)} ms (${times.length} queries)`);
    }
  } finally {
    await clean();
    await c.end();
  }
}

(async () => {
  const modelDir = process.argv[2];
  if (!modelDir) throw new Error('usage: node scripts/embedding/measure.js <model dir>');
  console.log(`node ${process.version}, ${require('node:os').cpus()[0].model}, ${require('node:os').cpus().length} cores`);
  console.log(`postgres: ${(await (async () => { const c = new Client(db); await c.connect(); const v = (await c.query('SHOW server_version')).rows[0].server_version; await c.end(); return v; })())}`);
  await throughput(join(modelDir));
  await search();
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
