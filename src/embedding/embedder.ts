import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EmbeddingProfile } from './embedding.entities';

/** Turns text into unit vectors under one profile. Callers add the query prefix themselves. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Where an embedder comes from. The real one loads model files from disk; tests provide a
 * fake, so the suite needs neither the model nor the network.
 */
export interface EmbeddingRuntime {
  /** False when the files for this profile are not on disk: a state, not an error. */
  available(profile: EmbeddingProfile): boolean;
  forProfile(profile: EmbeddingProfile): Promise<Embedder>;
}

export const EMBEDDING_RUNTIME = Symbol('EMBEDDING_RUNTIME');

/** The image bakes the model here (Dockerfile); EMBEDDING_MODEL_DIR points elsewhere for a developer. */
export const DEFAULT_MODEL_DIR = '/app/models';

export class EmbeddingProfileMismatch extends Error {}

/**
 * bge-small as ONNX on the CPU, through `@huggingface/transformers` (D19, D47).
 *
 * The library is required here, inside the first load, not at the top of the file: it
 * brings onnxruntime's native binary with it, and a process that never embeds — the
 * scheduler, every test — should not pay for loading one.
 *
 * Before the model is used, its files are hashed against the profile. A vector made by
 * weights the profile does not describe looks exactly like a correct one once stored, so
 * the only place to catch it is before the first one is made.
 */
export class OnnxEmbeddingRuntime implements EmbeddingRuntime {
  private readonly loading = new Map<string, Promise<Embedder>>();

  constructor(private readonly dir: string) {}

  available(profile: EmbeddingProfile): boolean {
    return existsSync(join(this.dir, profile.modelRepo, profile.weightsFile));
  }

  forProfile(profile: EmbeddingProfile): Promise<Embedder> {
    let pending = this.loading.get(profile.id);
    if (!pending) {
      pending = this.load(profile);
      // A failed load is not cached: the next request tries again rather than replaying
      // the same error for the life of the process.
      pending.catch(() => this.loading.delete(profile.id));
      this.loading.set(profile.id, pending);
    }
    return pending;
  }

  private async load(profile: EmbeddingProfile): Promise<Embedder> {
    const root = join(this.dir, profile.modelRepo);
    const checks: [string, string][] = [
      [profile.weightsFile, profile.weightsSha256],
      ['tokenizer.json', profile.tokenizerSha256],
    ];
    for (const [file, expected] of checks) {
      const actual = await sha256File(join(root, file));
      if (actual !== expected) {
        throw new EmbeddingProfileMismatch(
          `${profile.modelRepo}/${file} hashes to ${actual}, but profile ${profile.key} pins ${expected}; refusing to embed.`,
        );
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tf = require('@huggingface/transformers');
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = this.dir;
    const extract = await tf.pipeline('feature-extraction', profile.modelRepo, { dtype: 'fp32', device: 'cpu' });
    return {
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const out = await extract(texts, { pooling: profile.pooling, normalize: true });
        return out.tolist();
      },
    };
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}
