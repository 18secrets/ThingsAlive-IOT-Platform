// Fetches the files of the active embedding profile (QEMB1, D47) at its pinned revision
// and refuses any whose sha256 is not the pinned one. Used twice, so the two cannot drift:
// the Dockerfile bakes the model with it, and a developer fills a local directory with it
// for the opt-in real-model spec (test/library-embedding-model.spec.ts).
//
//   node scripts/embedding/fetch-model.js <dir>      then  EMBEDDING_MODEL_DIR=<dir>
//
// The revision and the two load-bearing hashes are the `embedding_profile` row's
// (1761500000000-EmbeddingIndex.ts); the service checks those two again before the model
// is used, so a mismatch here and a mismatch there are the same failure.
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const REPO = 'BAAI/bge-small-en-v1.5';
const REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
const FILES = {
  'onnx/model.onnx': '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'config.json': '094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
};

(async () => {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/embedding/fetch-model.js <dir>');
  for (const [file, expected] of Object.entries(FILES)) {
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== expected) throw new Error(`${file}: sha256 ${actual}, pinned ${expected}`);
    const out = join(dir, REPO, file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
    console.log(`${file}  ${body.length} bytes  ok`);
  }
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
