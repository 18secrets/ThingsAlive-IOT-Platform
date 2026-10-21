import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Embedder, EmbeddingRuntime } from '../src/embedding/embedder';
import { LibraryEmbeddingService } from '../src/embedding/library-embedding.service';
import { EvalSummary } from '../src/evaluation/evaluation.service';
import { GoldenSet, GoldenSetInvalid, loadGoldenSet, validateGoldenSet } from '../src/evaluation/retrieval-golden';
import {
  ISOLATION_PROBE_TENANT, NearestFn, productionNearest, RetrievalEvalService, RetrievalOptions,
} from '../src/evaluation/retrieval-eval.service';
import { aggregate, scoreQuery } from '../src/evaluation/retrieval-scoring';
import { createApp } from '../src/main';
import { withEvalSession } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'RetrievalEvalGrants1761700000000';
const DIM = 384;
const PREFIX = 'Represent this sentence for searching relevant passages: ';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
const SMOKE = join(__dirname, '..', 'docs', 'ai', 'eval', 'retrieval', 'smoke-demo-excavator.json');

/** QEMB1's stand-in for bge-small: a hashed bag of words, normalised. */
class BagOfWords implements Embedder {
  texts: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.texts.push(...texts);
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
        v[createHash('sha256').update(w).digest().readUInt16BE(0) % DIM] += 1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  }
}

const runtimeOf = (embedder: Embedder, available = true): EmbeddingRuntime => ({
  available: () => available, forProfile: async () => embedder,
});

const golden = (queries: GoldenSet['queries'], kind: GoldenSet['kind'] = 'authored'): GoldenSet => ({
  format: 'ta2.retrieval-golden@1', name: 'test set', version: '1', kind, authoredBy: 'the spec', authoredAt: '2026-10-20', queries,
});

const COOLER_Q: GoldenSet['queries'][number] = {
  id: 'q-cooler', classSlug: 'excavator', text: 'hydraulic oil cooler blocked',
  expect: [
    { kind: 'failure_mode', classSlug: 'excavator', code: 'COOLER-BLOCKED' },
    { kind: 'recommendation', classSlug: 'excavator', code: 'COOLER-BLOCKED', action: 'Clean the oil cooler fins and check the cooler fan' },
  ],
};
const THEFT_Q: GoldenSet['queries'][number] = {
  id: 'q-theft', text: 'fuel level drops overnight with the engine off',
  expect: [{ kind: 'failure_mode', classSlug: 'dg', code: 'FUEL-THEFT' }],
};

/**
 * The retrieval eval (task QEVAL1b). The embedder is QEMB1's fake, so the suite needs
 * neither the model nor the network; what is tested is that the eval scores the search
 * the api runs, reads the index without touching it, and fails on a cross-account hit.
 */
describeDb('evaluation: the retrieval eval', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qeval1b';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qeval1b-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  // Evaluation rows are append-only by trigger; TRUNCATE is the one way to empty them.
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "eval_result", "eval_run", "library_embedding",
      "client_equipment_class_recommendation", "client_equipment_class_failure_mode" CASCADE`);
  });

  const seedLibrary = async (tenant: string) => {
    const [cooler] = await owner.query(
      `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name, symptom, signals)
       VALUES ($1, 'excavator', 'COOLER-BLOCKED', 'Oil cooler blocked', 'Hydraulic oil temperature climbs under load', '{hydraulic_oil_temp}')
       RETURNING id`, [tenant]);
    const [theft] = await owner.query(
      `INSERT INTO client_equipment_class_failure_mode (tenant_id, client_equipment_class_slug, code, name, symptom, signals)
       VALUES ($1, 'dg', 'FUEL-THEFT', 'Fuel pilferage', 'Fuel level drops while the engine is off', '{fuel_level}')
       RETURNING id`, [tenant]);
    const [clean] = await owner.query(
      `INSERT INTO client_equipment_class_recommendation (tenant_id, client_equipment_class_slug, failure_mode_code, action, urgency)
       VALUES ($1, 'excavator', 'COOLER-BLOCKED', 'Clean the oil cooler fins and check the cooler fan', 'next_shift')
       RETURNING id`, [tenant]);
    return { cooler: cooler.id as string, theft: theft.id as string, clean: clean.id as string };
  };

  /** Seeds and indexes an account through QEMB1's own reindex, as the api would. */
  const indexed = async (scope: RequestScope, fake = new BagOfWords()) => {
    const ids = await seedLibrary(scope.tenantId);
    await new LibraryEmbeddingService(ds, runtimeOf(fake)).reindex(scope);
    return ids;
  };

  const evalWith = (fake: Embedder, available = true) => new RetrievalEvalService(ds, runtimeOf(fake, available));
  const opts = (set: GoldenSet, extra: Partial<RetrievalOptions> = {}): RetrievalOptions => ({
    dataset: 'real', golden: set, goldenSha256: 'f'.repeat(64), ...extra,
  });
  const run = (id: string) => owner.query(`SELECT * FROM eval_run WHERE id = $1`, [id]).then((r) => r[0]);
  const results = (runId: string) => owner.query(
    `SELECT tenant_id, external_id, subject, metrics FROM eval_result WHERE run_id = $1 ORDER BY tenant_id, subject`, [runId]);
  const summary = (s: EvalSummary) => s.summary as Record<string, any>;

  // ------------------------------------------------------------- G10, attempted

  it('1. the eval role cannot write a vector or the profile; a run leaves the index exactly as it was and embeds only the questions', async () => {
    const { cooler } = await indexed(acme);
    const vec = new Array(DIM).fill(0); vec[0] = 1;
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(
      `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, input_hash, vector)
       SELECT 'acme', id, 'failure_mode', $1, $2, $3::real[] FROM embedding_profile WHERE status = 'active'`,
      [cooler, 'a'.repeat(64), vec]))).rejects.toThrow(/permission denied/);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(`UPDATE library_embedding SET input_hash = $1`, ['b'.repeat(64)])))
      .rejects.toThrow(/permission denied/);
    await expect(withEvalSession(ds, 'platform', (m) => m.query(`UPDATE embedding_profile SET status = 'retired'`)))
      .rejects.toThrow(/permission denied/);

    const before = await owner.query(`SELECT id, input_hash, vector, indexed_at FROM library_embedding ORDER BY id`);
    const fake = new BagOfWords();
    const out = await evalWith(fake).runRetrieval(opts(golden([COOLER_Q, THEFT_Q])));
    expect(out.status).toBe('completed');
    expect(await owner.query(`SELECT id, input_hash, vector, indexed_at FROM library_embedding ORDER BY id`)).toEqual(before);
    // Only the two questions went through the model, each with the query prefix: no library text, so no reindex.
    expect(fake.texts).toEqual([PREFIX + COOLER_Q.text, PREFIX + THEFT_Q.text]);
  });

  // ------------------------------------------------------------- scoring

  it('2. recall@8, reciprocal rank and hit@1 equal hand-worked values; over nothing they are null with a reason', () => {
    // Expected at ranks 3 and 12 of 30: one of two inside the cut-off; first found at 3.
    const ranked = Array.from({ length: 30 }, (_, i) => `r${i + 1}`);
    expect(scoreQuery(['r3', 'r12'], ranked)).toEqual({ expected: 2, ranks: [3, 12], recallAt8: 0.5, reciprocalRank: 1 / 3, hitAt1: false });
    expect(scoreQuery(['r1'], ranked)).toMatchObject({ recallAt8: 1, reciprocalRank: 1, hitAt1: true });
    // Scored and not found is a real zero.
    expect(scoreQuery(['nope'], ranked)).toEqual({ expected: 1, ranks: [null], recallAt8: 0, reciprocalRank: 0, hitAt1: false });
    expect(aggregate([scoreQuery(['r3', 'r12'], ranked), scoreQuery(['r1'], ranked)]))
      .toEqual({ n: 2, recallAt8: 0.75, mrr: 0.666667, hitAt1: 0.5, reason: null });
    expect(aggregate([])).toEqual({ n: 0, recallAt8: null, mrr: null, hitAt1: null, reason: 'no_scored_queries' });
  });

  it('3. the eval ranks exactly as the api search does, for the same account and question', async () => {
    const { cooler, clean } = await indexed(acme);
    const fake = new BagOfWords();
    const api = await new LibraryEmbeddingService(ds, runtimeOf(fake)).search(acme, COOLER_Q.text, 30, 'excavator');
    const out = await evalWith(fake).runRetrieval(opts(golden([COOLER_Q])));
    const [row] = await results(out.runId);
    const ranks = [cooler, clean].map((id) => api.hits.find((h) => h.id === id)!.rank);
    expect(row.metrics.ranks).toEqual(ranks);
    expect(row.metrics.reciprocalRank).toBe(1 / Math.min(...ranks));
    expect(row).toMatchObject({ tenant_id: 'acme', external_id: 'excavator', subject: 'q-cooler' });
    expect(summary(out).metrics).toMatchObject({ n: 1, recallAt8: 1 });
    expect(summary(out).foundBy).toMatchObject({ semantic: 2, lexical: null, exactIdentifier: null });
    expect(out.dataset).toBe('real');
  });

  it('4. a question whose class or expected entry an account lacks is excluded with its reason, not scored as a miss', async () => {
    await indexed(acme);
    const absent = { ...THEFT_Q, id: 'q-absent', expect: [{ kind: 'failure_mode' as const, classSlug: 'dg', code: 'NO-SUCH-MODE' }] };
    const noClass = { ...COOLER_Q, id: 'q-crane', classSlug: 'crane' };
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([absent, noClass])));
    expect(out.status).toBe('completed');
    expect(summary(out).pairs).toMatchObject({ total: 2, scored: 0, excluded: { expected_entry_absent: 1, class_absent: 1 } });
    expect(summary(out).metrics).toEqual({ n: 0, recallAt8: null, mrr: null, hitAt1: null, reason: 'no_scored_queries' });
    const rows = await results(out.runId);
    expect(rows.map((r: { metrics: { excluded: string } }) => r.metrics.excluded).sort()).toEqual(['class_absent', 'expected_entry_absent']);
  });

  it('4b. an account named on the command line with no vectors is excluded as index_empty', async () => {
    await seedLibrary('acme');
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q]), { tenants: ['acme'] }));
    expect(summary(out).pairs.excluded).toEqual({ index_empty: 1 });
    expect(summary(out).coverage).toEqual({ sources: 3, indexed: 0, stale: 3 });
  });

  // ------------------------------------------------------------- isolation (§3, gated)

  it('5. every question is run as every other account and as one that owns nothing: zero cross-account hits, gate passed', async () => {
    await indexed(acme);
    await indexed(globex);
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q, THEFT_Q])));
    expect(out.status).toBe('completed');
    // 2 accounts × 2 questions, each probed as the other account and as the empty probe.
    expect(summary(out).isolation).toEqual({ probes: 8, crossTenantHits: 0, gate: 'passed', breaches: [] });
    expect(summary(out).pairs.scored).toBe(4);
  });

  it('5b. a planted cross-account hit fails the whole run, naming the question', async () => {
    const { cooler } = await indexed(acme);
    // A search that leaks: as the probe account it returns acme's row as well.
    const leaky: NearestFn = async (m, profileId, vector, k, cls) => {
      const rows = await productionNearest(m, profileId, vector, k, cls);
      const [{ t }] = await m.query(`SELECT current_setting('ta.tenant_id', true) AS t`);
      return t === ISOLATION_PROBE_TENANT
        ? [...rows, { embedding_id: '00000000-0000-0000-0000-000000000000', source_kind: 'failure_mode', source_id: cooler, rank: rows.length + 1 }]
        : rows;
    };
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q]), { probeNearest: leaky }));
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/^isolation_breach: 1 hit/);
    expect(summary(out).isolation).toMatchObject({ crossTenantHits: 1, gate: 'failed', breaches: [{ query: 'q-cooler', asProbe: true }] });
    expect((await run(out.runId)).status).toBe('failed');
  });

  // ------------------------------------------------------------- labelling and refusals

  it('6. a smoke golden set is labelled seeded even when the run is asked to be real; the run records profile and golden hash', async () => {
    await indexed(acme);
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q], 'smoke')));
    const row = await run(out.runId);
    expect(row.dataset).toBe('seeded');
    expect(row.dataset_note).toMatch(/smoke set/);
    expect(summary(out).claim).toMatch(/^smoke test/);
    expect(row.versions).toMatchObject({
      scorer: 'qeval1b-1',
      golden: { kind: 'smoke', sha256: 'f'.repeat(64), queries: 1 },
      embeddingProfile: { key: 'bge-small-en-v1.5', revision: '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a', chunkerVersion: 'library-entry@1' },
      retrieval: { methods: ['semantic'], k: 30, recallCutoff: 8 },
    });
  });

  it('7. without the model files the run fails with embedding_not_configured, and nothing is scored', async () => {
    await indexed(acme);
    const out = await evalWith(new BagOfWords(), false).runRetrieval(opts(golden([COOLER_Q])));
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/^embedding_not_configured/);
    expect(await results(out.runId)).toEqual([]);
  });

  it('8. the run row holds aggregates only: no account id appears in it', async () => {
    await indexed(acme);
    await indexed(globex);
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q])));
    const text = JSON.stringify(await run(out.runId));
    expect(text).not.toMatch(/acme|globex/);
    // The per-account rows are each account's own.
    expect((await results(out.runId)).map((r: { tenant_id: string }) => r.tenant_id)).toEqual(['acme', 'globex']);
  });

  it('9. two runs fired together: both settle, one runs, one reports the lock held, results written once', async () => {
    await indexed(acme);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const svc = evalWith(new BagOfWords());
    const a = svc.runRetrieval(opts(golden([COOLER_Q]), { onLocked: () => gate }));
    const b = svc.runRetrieval(opts(golden([COOLER_Q]), { onLocked: () => gate }));
    void Promise.race([a, b]).then(() => open());
    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(settled.map((x) => (x as PromiseFulfilledResult<EvalSummary>).value.status).sort()).toEqual(['completed', 'lock_held']);
    expect((await owner.query(`SELECT count(*)::int AS n FROM eval_result`))[0].n).toBe(1);
  });

  it('10. a run that exhausts its budget says so and records what it did not reach', async () => {
    await indexed(acme);
    const out = await evalWith(new BagOfWords()).runRetrieval(opts(golden([COOLER_Q, THEFT_Q]), { budgetPairs: 1 }));
    expect(out.status).toBe('budget_exhausted');
    expect((await run(out.runId)).unreached).toBe(1);
    const rows = await results(out.runId);
    expect(rows.find((r: { subject: string }) => r.subject === 'q-theft').metrics).toEqual({ unreached: 'budget_exhausted' });
  });

  // ------------------------------------------------------------- the golden file

  it('11. the shipped smoke set loads; a malformed set is refused, naming what is wrong', () => {
    const { set, sha256 } = loadGoldenSet(SMOKE);
    expect(set).toMatchObject({ kind: 'smoke', format: 'ta2.retrieval-golden@1' });
    expect(set.queries.length).toBeGreaterThan(0);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const ok = { ...golden([COOLER_Q]) } as Record<string, unknown>;
    expect(() => validateGoldenSet({ ...ok, format: 'v0' })).toThrow(GoldenSetInvalid);
    expect(() => validateGoldenSet({ ...ok, kind: 'guess' })).toThrow(/kind must be/);
    expect(() => validateGoldenSet({ ...ok, queries: [{ ...COOLER_Q, expect: [] }] })).toThrow(/queries\[0\]\.expect/);
    expect(() => validateGoldenSet({ ...ok, queries: [COOLER_Q, COOLER_Q] })).toThrow(/used twice/);
    expect(() => validateGoldenSet({ ...ok, queries: [{ ...COOLER_Q, expect: [{ kind: 'recommendation', classSlug: 'x', code: 'Y' }] }] }))
      .toThrow(/expect\[0\]\.action/);
  });

  // ------------------------------------------------------------- migration

  it('12. the down path takes the eval role\'s read of the index away and leaves the index alone', async () => {
    await indexed(acme);
    const vectors = (await owner.query(`SELECT count(*)::int AS n FROM library_embedding`))[0].n;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT has_table_privilege('ta_eval', 'library_embedding', 'SELECT') AS g`)).toEqual([{ g: false }]);
    await expect(withEvalSession(ds, { tenantId: 'acme' }, (m) => m.query(`SELECT count(*) FROM library_embedding`)))
      .rejects.toThrow(/permission denied/);
    expect((await owner.query(`SELECT count(*)::int AS n FROM library_embedding`))[0].n).toBe(vectors);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT has_table_privilege('ta_eval', 'library_embedding', 'SELECT') AS g`)).toEqual([{ g: true }]);
  });
});
