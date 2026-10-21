/**
 * @jest-environment ./test/environments/native-typed-arrays.js
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { OnnxEmbeddingRuntime } from '../src/embedding/embedder';
import { EmbeddingProfile } from '../src/embedding/embedding.entities';

/**
 * The real bge-small, opt-in (task QEMB1). Needs the model files, which the suite does not
 * download:
 *
 *   node scripts/embedding/fetch-model.js /some/dir
 *   EMBEDDING_MODEL_DIR=/some/dir npx jest test/library-embedding-model.spec.ts
 *
 * Skipped, and says so, without them. What it proves that the fake cannot: the pinned files
 * pass the profile's hash check, the library loads them offline, and the vectors are the
 * profile's shape — 384 long, unit length — with a related passage closer than an unrelated one.
 */
const dir = process.env.EMBEDDING_MODEL_DIR;
// The seeded row's values (1761500000000-EmbeddingIndex.ts), without a database.
const profile = {
  id: 'real-model', key: 'bge-small-en-v1.5', modelRepo: 'BAAI/bge-small-en-v1.5', weightsFile: 'onnx/model.onnx',
  weightsSha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
  tokenizerSha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  dimension: 384, pooling: 'cls', queryPrefix: 'Represent this sentence for searching relevant passages: ',
} as EmbeddingProfile;
const present = !!dir && existsSync(join(dir, profile.modelRepo, profile.weightsFile));

const describeModel: jest.Describe = present
  ? describe
  : ((name: string, fn: any) => {
      // eslint-disable-next-line no-console
      console.warn(`SKIPPED "${name}" — EMBEDDING_MODEL_DIR does not hold ${profile.modelRepo}.`);
      return describe.skip(name, fn);
    }) as any;

describeModel('bge-small, the real model', () => {
  it('loads offline, embeds unit vectors of the profile\'s dimension, and ranks a related passage above an unrelated one', async () => {
    const embedder = await new OnnxEmbeddingRuntime(dir!).forProfile(profile);
    const [q] = await embedder.embed([`${profile.queryPrefix}why is the hydraulic oil running hot`]);
    const [related, unrelated] = await embedder.embed([
      'Failure mode: Oil cooler blocked. Symptom: Hydraulic oil temperature climbs under load.',
      'Failure mode: Fuel pilferage. Symptom: Fuel level drops while the engine is off.',
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(q).toHaveLength(384);
    expect(Math.abs(dot(q, q) - 1)).toBeLessThan(1e-3);
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated));
  }, 60_000);
});
