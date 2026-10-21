import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Embedder, EmbeddingProfileMismatch, EmbeddingRuntime, OnnxEmbeddingRuntime } from '../src/embedding/embedder';
import { EmbeddingProfile } from '../src/embedding/embedding.entities';
import { LibraryEmbeddingService } from '../src/embedding/library-embedding.service';
import { createApp } from '../src/main';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SECRET = 'test-secret-library-embedding';
const ISSUER = 'things-alive-library-embedding-test';
const MIGRATION = 'EmbeddingIndex1761500000000';
const DIM = 384;
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
const staff: RequestScope = { tenantId: '', userId: 'staff-1', roles: ['master-admin'], isPlatformRole: true };

/**
 * A deterministic stand-in for bge-small: a hashed bag of words, normalised. Texts that
 * share words land near each other, which is all a ranking assertion needs, and the
 * suite needs neither the model files nor the network. The real model has its own
 * opt-in spec at the bottom.
 */
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

const runtimeOf = (embedder: Embedder): EmbeddingRuntime => ({ available: () => true, forProfile: async () => embedder });

/** A unit vector along one axis, for writing rows by hand. */
const axis = (i = 0, dim = DIM) => Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0));

/**
 * Embeddings without pgvector (task QEMB1, D47). The vectors, their profile and the
 * search are all in Postgres under row-level security, so what is tested is what the
 * database refuses, not only what the service avoids doing.
 */
describeDb('library embeddings: profile, index and semantic search', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let profileId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    // An empty directory: the app as deployed without the model files.
    process.env.EMBEDDING_MODEL_DIR = mkdtempSync(join(tmpdir(), 'no-model-'));
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    profileId = (await owner.getRepository(EmbeddingProfile).findOneByOrFail({ status: 'active' })).id;
  }, 60_000);

  afterAll(async () => {
    delete process.env.EMBEDDING_MODEL_DIR;
    await app?.close();
    await owner?.destroy();
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "library_embedding", "client_equipment_class_recommendation", "client_equipment_class_failure_mode" CASCADE`);
  });

  const seedLibrary = async (tenant = 'acme') => {
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

  const vectors = async (tenant = 'acme') =>
    (await owner.query(`SELECT count(*)::int AS n FROM library_embedding WHERE tenant_id = $1`, [tenant]))[0].n as number;

  /** Inserts as the tenant, through row-level security, exactly as the service would. */
  const insertAs = (tenant: string, row: { failureModeId?: string; recommendationId?: string; vector: unknown; profile?: string }) =>
    withTenantId(ds, tenant, (m) => m.query(
      `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, recommendation_id, input_hash, vector)
       VALUES ($1, $2, $3, $4, $5, $6, $7::real[])`,
      [tenant, row.profile ?? profileId, row.failureModeId ? 'failure_mode' : 'recommendation', row.failureModeId ?? null,
        row.recommendationId ?? null, 'a'.repeat(64), row.vector]));

  // ============================================================== the profile

  it('1. seeds one active bge-small profile, and the database refuses a second active one, an edit and a delete', async () => {
    const p = await owner.getRepository(EmbeddingProfile).findOneByOrFail({ id: profileId });
    expect(p).toMatchObject({
      key: 'bge-small-en-v1.5', modelRepo: 'BAAI/bge-small-en-v1.5', revision: '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a',
      runtime: 'onnx-cpu', dimension: 384, pooling: 'cls', normalization: 'l2', distance: 'cosine', chunkerVersion: 'library-entry@1',
      license: 'mit', status: 'active',
    });
    await expect(owner.query(
      `INSERT INTO embedding_profile (key, model_repo, revision, runtime, weights_file, weights_sha256, tokenizer_sha256, dimension,
         pooling, normalization, distance, query_prefix, max_tokens, language, chunker_version, license, status, approved_by, approved_at)
       SELECT key, model_repo, 'other', runtime, weights_file, weights_sha256, tokenizer_sha256, dimension, pooling, normalization,
         distance, query_prefix, max_tokens, language, chunker_version, license, 'active', approved_by, approved_at
         FROM embedding_profile WHERE id = $1`, [profileId])).rejects.toThrow(/uq_embedding_profile_one_active/);
    await expect(owner.query(`UPDATE embedding_profile SET dimension = 768 WHERE id = $1`, [profileId])).rejects.toThrow(/immutable/);
    await expect(owner.query(`DELETE FROM embedding_profile WHERE id = $1`, [profileId])).rejects.toThrow(/never deleted/);
    // And the application role cannot write it at all.
    await expect(withTenantId(ds, 'acme', (m) => m.query(`UPDATE embedding_profile SET status = 'retired'`)))
      .rejects.toThrow(/permission denied/);
  });

  // ============================================================== indexing

  it('2. reindex embeds every entry; again embeds nothing; an edited symptom re-embeds exactly that entry', async () => {
    const { cooler } = await seedLibrary();
    const fake = new BagOfWords();
    const svc = new LibraryEmbeddingService(ds, runtimeOf(fake));

    expect(await svc.reindex(acme)).toMatchObject({ sources: 3, embedded: 3, unchanged: 0, profile: { key: 'bge-small-en-v1.5' } });
    expect(await vectors()).toBe(3);
    // Passages are embedded without the query prefix.
    expect(fake.texts.some((t) => t.startsWith('Represent this sentence'))).toBe(false);

    expect(await svc.reindex(acme)).toMatchObject({ embedded: 0, unchanged: 3 });
    expect(fake.texts).toHaveLength(3);

    await owner.query(`UPDATE client_equipment_class_failure_mode SET symptom = 'Oil runs hot' WHERE id = $1`, [cooler]);
    expect(await svc.reindex(acme)).toMatchObject({ embedded: 1, unchanged: 2 });
    expect(fake.texts.at(-1)).toContain('Oil runs hot');
    expect(await vectors()).toBe(3);
  });

  it('3. two reindexes fired together both settle, the model runs once per entry, and one vector exists per entry', async () => {
    await seedLibrary();
    const fake = new BagOfWords();
    const svc = new LibraryEmbeddingService(ds, runtimeOf(fake));
    const results = await Promise.allSettled([svc.reindex(acme), svc.reindex(acme)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const embedded = results.map((r) => (r as PromiseFulfilledResult<{ embedded: number }>).value.embedded).sort();
    expect(embedded).toEqual([0, 3]);
    expect(fake.texts).toHaveLength(3);
    expect(await vectors()).toBe(3);
  });

  // ============================================================== search

  it('4. search ranks the closest entry first, numbers ranks 1..n, carries no score, and narrows by class', async () => {
    const { cooler, clean, theft } = await seedLibrary();
    const fake = new BagOfWords();
    const svc = new LibraryEmbeddingService(ds, runtimeOf(fake));
    await svc.reindex(acme);

    const out = await svc.search(acme, 'hydraulic oil cooler blocked');
    expect(out.method).toBe('semantic');
    expect(out.hits.map((h) => h.rank)).toEqual([1, 2, 3]);
    // The two cooler entries share the query's words; the fuel entry shares none of them.
    expect(out.hits.slice(0, 2).map((h) => h.id).sort()).toEqual([cooler, clean].sort());
    expect(out.hits.at(-1)!.id).toBe(theft);
    expect(out.hits.find((h) => h.id === cooler)).toMatchObject({
      kind: 'failure_mode', classSlug: 'excavator', code: 'COOLER-BLOCKED', title: 'Oil cooler blocked',
    });
    expect(out.hits.find((h) => h.id === clean)).toMatchObject({
      kind: 'recommendation', classSlug: 'excavator', code: 'COOLER-BLOCKED', title: 'Clean the oil cooler fins and check the cooler fan',
    });
    for (const h of out.hits) expect(Object.keys(h).sort()).toEqual(['classSlug', 'code', 'id', 'kind', 'rank', 'text', 'title']);
    // The query, and only the query, carries the model's retrieval instruction.
    expect(fake.texts.at(-1)).toBe('Represent this sentence for searching relevant passages: hydraulic oil cooler blocked');

    const dg = await svc.search(acme, 'hydraulic oil cooler blocked', 30, 'dg');
    expect(dg.hits.map((h) => h.id)).toEqual([theft]);
    expect((await svc.search(acme, 'cooler', 2)).hits).toHaveLength(2);
  });

  it('5. coverage says how many entries are stale after an edit, and none after a reindex', async () => {
    const { theft } = await seedLibrary();
    const svc = new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords()));
    expect((await svc.search(acme, 'fuel')).coverage).toEqual({ sources: 3, indexed: 0, stale: 3 });
    await svc.reindex(acme);
    expect((await svc.search(acme, 'fuel')).coverage).toEqual({ sources: 3, indexed: 3, stale: 0 });
    await owner.query(`UPDATE client_equipment_class_failure_mode SET name = 'Diesel pilferage' WHERE id = $1`, [theft]);
    expect((await svc.search(acme, 'fuel')).coverage).toEqual({ sources: 3, indexed: 3, stale: 1 });
  });

  // ============================================================== refusals, attempted

  it('6. the database refuses a short vector, a NULL element, a non-unit vector and a wrong-length query', async () => {
    const { cooler } = await seedLibrary();
    await expect(insertAs('acme', { failureModeId: cooler, vector: axis(0, 383) })).rejects.toThrow(/383 elements under a profile of dimension 384/);
    await expect(insertAs('acme', { failureModeId: cooler, vector: [null, ...axis(0, 383)] })).rejects.toThrow(/ck_library_embedding_vector_shape/);
    await expect(insertAs('acme', { failureModeId: cooler, vector: axis(0).map((x) => x * 2) })).rejects.toThrow(/not unit length/);
    await expect(insertAs('acme', { failureModeId: cooler, vector: axis(0) })).resolves.toBeDefined();
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `SELECT * FROM library_embedding_nearest($1, $2::real[], 5)`, [profileId, axis(0, 768)])))
      .rejects.toThrow(/a query of 768 elements against a profile of dimension 384/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `SELECT * FROM library_embedding_nearest($1, $2::real[], 31)`, [profileId, axis(0)])))
      .rejects.toThrow(/k must be 1 to 30/);
  });

  it('6b. a vector under a retired profile is refused, and a source kind that disagrees with its column is refused', async () => {
    const { cooler, clean } = await seedLibrary();
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, input_hash, vector)
       VALUES ('acme', $1, 'recommendation', $2, $3, $4::real[])`, [profileId, cooler, 'a'.repeat(64), axis(0)])))
      .rejects.toThrow(/ck_library_embedding_source/);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, recommendation_id, input_hash, vector)
       VALUES ('acme', $1, 'failure_mode', $2, $3, $4, $5::real[])`, [profileId, cooler, clean, 'a'.repeat(64), axis(0)])))
      .rejects.toThrow(/ck_library_embedding_source/);

    // Retire the seeded profile inside a transaction that is rolled back, so the rest of
    // the file still has an active one.
    await expect(owner.transaction(async (m) => {
      await m.query(`UPDATE embedding_profile SET status = 'retired' WHERE id = $1`, [profileId]);
      await m.query(`SELECT set_config('ta.tenant_id', 'acme', true)`);
      await m.query(
        `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, input_hash, vector)
         VALUES ('acme', $1, 'failure_mode', $2, $3, $4::real[])`, [profileId, cooler, 'a'.repeat(64), axis(0)]);
    })).rejects.toThrow(/is retired, and only the active profile is indexed/);
    expect((await owner.getRepository(EmbeddingProfile).findOneByOrFail({ id: profileId })).status).toBe('active');
  });

  // ============================================================== isolation, attempted

  it('7. another account sees none of these entries, and cannot attach a vector to them', async () => {
    const { cooler } = await seedLibrary('acme');
    await seedLibrary('globex');
    const svc = new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords()));
    await svc.reindex(acme);
    expect(await vectors('globex')).toBe(0);

    const seen = await svc.search(globex, 'hydraulic oil cooler blocked');
    expect(seen.hits).toEqual([]);
    expect(seen.coverage).toEqual({ sources: 3, indexed: 0, stale: 3 });
    expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT count(*)::int AS n FROM library_embedding`))).toEqual([{ n: 0 }]);

    // Under its own tenant id, pointing at acme's row: the composite key has no such pair.
    await expect(insertAs('globex', { failureModeId: cooler, vector: axis(1) })).rejects.toThrow(/fk_library_embedding_failure_mode/);
    // Under acme's tenant id from a globex session: the policy refuses it.
    await expect(withTenantId(ds, 'globex', (m) => m.query(
      `INSERT INTO library_embedding (tenant_id, profile_id, source_kind, failure_mode_id, input_hash, vector)
       VALUES ('acme', $1, 'failure_mode', $2, $3, $4::real[])`, [profileId, cooler, 'a'.repeat(64), axis(1)])))
      .rejects.toThrow(/row-level security/);
  });

  it('7b. staff, who have no account, are refused rather than told the library is empty', async () => {
    const svc = new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords()));
    await expect(svc.search(staff, 'oil')).rejects.toThrow(/inside one account/);
    await expect(svc.reindex(staff)).rejects.toThrow(/inside one account/);
  });

  it('8. deleting a failure mode deletes its vector, and its recommendation\'s', async () => {
    const { cooler } = await seedLibrary();
    await new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords())).reindex(acme);
    expect(await vectors()).toBe(3);
    await withTenantId(ds, 'acme', async (m) => {
      await m.query(`DELETE FROM client_equipment_class_recommendation WHERE failure_mode_code = 'COOLER-BLOCKED'`);
      await m.query(`DELETE FROM client_equipment_class_failure_mode WHERE id = $1`, [cooler]);
    });
    expect(await vectors()).toBe(1);
    // And the application role cannot delete a vector by itself.
    await expect(withTenantId(ds, 'acme', (m) => m.query(`DELETE FROM library_embedding`))).rejects.toThrow(/permission denied/);
  });

  // ============================================================== the runtime

  it('9. weights that do not hash to the profile are refused before anything is embedded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-model-'));
    const root = join(dir, 'BAAI', 'bge-small-en-v1.5');
    mkdirSync(join(root, 'onnx'), { recursive: true });
    writeFileSync(join(root, 'onnx', 'model.onnx'), 'not the model');
    writeFileSync(join(root, 'tokenizer.json'), '{}');
    const runtime = new OnnxEmbeddingRuntime(dir);
    const profile = await owner.getRepository(EmbeddingProfile).findOneByOrFail({ id: profileId });
    expect(runtime.available(profile)).toBe(true);
    await expect(runtime.forProfile(profile)).rejects.toThrow(EmbeddingProfileMismatch);
    await seedLibrary();
    await expect(new LibraryEmbeddingService(ds, runtime).reindex(acme)).rejects.toMatchObject({
      response: { code: 'embedding_profile_mismatch' },
    });
    expect(await vectors()).toBe(0);
  });

  describe('over HTTP', () => {
    const auth = async (roles = ['admin']) => `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000e1', client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER })}`;

    it('10. with no model files, search and reindex answer 503 embedding_not_configured', async () => {
      const search = await request(app.getHttpServer()).post('/api/v1/library-embeddings/search')
        .set('Authorization', await auth()).send({ query: 'oil' });
      expect(search.status).toBe(503);
      expect(JSON.stringify(search.body)).toContain('embedding_not_configured');
      const reindex = await request(app.getHttpServer()).post('/api/v1/library-embeddings/reindex').set('Authorization', await auth());
      expect(reindex.status).toBe(503);
    });

    it('10b. a caller without prediction.read is refused, and a limit past 30 is refused', async () => {
      expect((await request(app.getHttpServer()).post('/api/v1/library-embeddings/search')
        .set('Authorization', await auth(['nobody'])).send({ query: 'oil' })).status).toBe(403);
      expect((await request(app.getHttpServer()).post('/api/v1/library-embeddings/search')
        .set('Authorization', await auth()).send({ query: 'oil', limit: 31 })).status).toBe(400);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it(`11. ${MIGRATION} down drops the tables, function and triggers with real rows in them, and up restores them`, async () => {
    await seedLibrary();
    await new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords())).reindex(acme);
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('library_embedding')::text AS t, to_regclass('embedding_profile')::text AS p,
        to_regproc('library_embedding_vector_guard')::text AS g, to_regproc('embedding_profile_guard')::text AS h,
        to_regclass('uq_client_failure_mode_tenant_id')::text AS i`))
      .toEqual([{ t: null, p: null, g: null, h: null, i: null }]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'library_embedding_nearest'`))[0].n).toBe(0);
    // The library itself is untouched by the down path.
    expect((await owner.query(`SELECT count(*)::int AS n FROM client_equipment_class_failure_mode`))[0].n).toBe(2);
    await owner.runMigrations({ transaction: 'all' });
    profileId = (await owner.getRepository(EmbeddingProfile).findOneByOrFail({ status: 'active' })).id;
    expect(await new LibraryEmbeddingService(ds, runtimeOf(new BagOfWords())).reindex(acme)).toMatchObject({ embedded: 3 });
  });
});
