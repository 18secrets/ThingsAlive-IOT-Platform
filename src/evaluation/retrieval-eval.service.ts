import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';
import { EMBEDDING_RUNTIME, EmbeddingRuntime } from '../embedding/embedder';
import { EmbeddingProfile, LibrarySourceKind } from '../embedding/embedding.entities';
import { MAX_RESULTS } from '../embedding/library-embedding.service';
import { CHUNKER_VERSION, failureModeText, inputHash, recommendationText } from '../embedding/library-text';
import { withEvalSession } from '../scope/tenant-session';
import { tryTakePassLock } from '../shift/services/pass-lock';
import { EvalDataset, EvalResult, EvalRun, EvalStatus } from './evaluation.entities';
import { EVAL_LOCK_KEYS, EvalSummary } from './evaluation.service';
import { GoldenExpectation, GoldenSet } from './retrieval-golden';
import { aggregate, QueryScore, RECALL_CUTOFF, scoreQuery } from './retrieval-scoring';

/** Bumped when the scoring changes, so two runs' numbers are known to be comparable or not. */
export const RETRIEVAL_SCORER_VERSION = 'qeval1b-1';
export const DEFAULT_RETRIEVAL_BUDGET_SECONDS = 15 * 60;
/** (account, query) pairs a run may score before it stops and says what it did not reach. */
export const DEFAULT_RETRIEVAL_BUDGET_PAIRS = 5000;
/**
 * A tenant id that owns nothing. Every query is also run as it, so the isolation check
 * has a second account to run as even where only one account has a library.
 */
export const ISOLATION_PROBE_TENANT = 'qeval1b-isolation-probe';

export interface NearestRow { embedding_id: string; source_kind: LibrarySourceKind; source_id: string; rank: number }

/** The production comparison: QEMB1's `library_embedding_nearest`, under the caller's RLS. */
export type NearestFn = (
  m: EntityManager, profileId: string, vector: number[], k: number, classSlug: string | null,
) => Promise<NearestRow[]>;

export const productionNearest: NearestFn = (m, profileId, vector, k, classSlug) => m.query(
  `SELECT "embedding_id", "source_kind", "source_id", "rank"
     FROM library_embedding_nearest($1, $2::real[], $3, $4) ORDER BY "rank"`,
  [profileId, vector, k, classSlug],
);

export interface RetrievalOptions {
  dataset: EvalDataset;
  datasetNote?: string;
  golden: GoldenSet;
  /** sha256 of the golden file, recorded so a result names exactly what it scored. */
  goldenSha256: string;
  /** Defaults to every account with vectors under the active profile. */
  tenants?: string[];
  budgetSeconds?: number;
  budgetPairs?: number;
  clock?: () => number;
  onLocked?: () => Promise<void>;
  /** The search as the isolation probe runs it; a test replaces it to plant a cross-account hit. */
  probeNearest?: NearestFn;
}

interface TenantLibrary {
  /** Library key → row id: `fm|class|code` and `rec|class|code|action`. */
  ids: Map<string, string>;
  classes: Set<string>;
  /** Every row id and vector id the account owns: anything a probe returns from here is a breach. */
  owned: Set<string>;
  coverage: { sources: number; indexed: number; stale: number };
}

const fmKey = (cls: string, code: string) => `fm|${cls}|${code}`;
const recKey = (cls: string, code: string, action: string) => `rec|${cls}|${code}|${action}`;
const keyOfExpectation = (e: GoldenExpectation) =>
  (e.kind === 'failure_mode' ? fmKey(e.classSlug, e.code) : recKey(e.classSlug, e.code, e.action));

/**
 * QEVAL1b: the retrieval eval (QEVAL1 §3) over what QEMB1 ships — semantic search only,
 * through the same embedder and the same SQL comparison the api uses, so what is scored
 * is the configuration that answers people, tied to the profile that made its vectors.
 *
 * It reads the index as it stands and never builds it: everything runs as `ta_eval`
 * (`withEvalSession`), which can read the vectors and cannot write them, so an eval can
 * neither reindex nor leave a vector behind (G10). Stale or missing vectors are reported
 * beside the numbers, not repaired.
 *
 * Only the isolation check is gated (§3): any hit, as another account, on a row the first
 * account owns fails the whole run. Nothing else is judged; no target exists (Q2).
 */
@Injectable()
export class RetrievalEvalService {
  private readonly logger = new Logger(RetrievalEvalService.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(EMBEDDING_RUNTIME) private readonly runtime: EmbeddingRuntime,
  ) {}

  async runRetrieval(opts: RetrievalOptions, now = new Date()): Promise<EvalSummary> {
    const budgetSeconds = opts.budgetSeconds ?? DEFAULT_RETRIEVAL_BUDGET_SECONDS;
    const budgetPairs = opts.budgetPairs ?? DEFAULT_RETRIEVAL_BUDGET_PAIRS;
    // A smoke golden set is a smoke test whatever the data under it (§5).
    const smoke = opts.golden.kind === 'smoke';
    const dataset: EvalDataset = smoke ? 'seeded' : opts.dataset;
    const datasetNote = smoke && opts.dataset === 'real'
      ? [opts.datasetNote, 'relabelled seeded: the golden set is a smoke set'].filter(Boolean).join('; ')
      : opts.datasetNote ?? null;

    const profile = await withEvalSession(this.ds, 'platform', (m) =>
      m.getRepository(EmbeddingProfile).findOne({ where: { status: 'active' } }));
    // The index has no time window; the run covers it under this profile, from the
    // profile's approval to now.
    const windowFrom = profile && profile.approvedAt < now ? profile.approvedAt : new Date(now.getTime() - 1);
    const golden = {
      name: opts.golden.name, version: opts.golden.version, kind: opts.golden.kind,
      authoredBy: opts.golden.authoredBy, authoredAt: opts.golden.authoredAt, sha256: opts.goldenSha256,
      queries: opts.golden.queries.length,
    };
    const versions = {
      scorer: RETRIEVAL_SCORER_VERSION, golden,
      embeddingProfile: profile && {
        id: profile.id, key: profile.key, revision: profile.revision, weightsSha256: profile.weightsSha256,
        chunkerVersion: profile.chunkerVersion,
      },
      retrieval: {
        methods: ['semantic'], k: MAX_RESULTS, recallCutoff: RECALL_CUTOFF, classFilter: 'the query\'s classSlug when given',
        note: 'QEMB1 ships semantic search only; lexical, exact-identifier and RRF wait for a document store (D47)',
      },
    };
    const base = {
      kind: 'retrieval' as const, dataset, datasetNote, versions, windowFrom, windowTo: now,
      budgetSeconds, budgetSeries: budgetPairs, startedAt: now,
    };

    const lock = await tryTakePassLock(this.ds, EVAL_LOCK_KEYS.retrieval);
    if (!lock) {
      const run = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).save({
        ...base, status: 'lock_held', finishedAt: now,
      }));
      return { runId: run.id, status: 'lock_held', dataset, summary: null, error: null };
    }
    try {
      await opts.onLocked?.();
      return await this.retrieval(opts, base, profile, now);
    } finally {
      await lock.release();
    }
  }

  private async retrieval(
    opts: RetrievalOptions,
    base: Omit<EvalRun, 'id' | 'status' | 'finishedAt' | 'unreached' | 'summary' | 'error'>,
    profile: EmbeddingProfile | null,
    now: Date,
  ): Promise<EvalSummary> {
    const clock = opts.clock ?? Date.now;
    const t0 = clock();
    const overBudget = () => clock() - t0 > base.budgetSeconds * 1000;
    const run = await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).save({
      ...base, status: 'running' as const, finishedAt: null,
    }));
    const finish = async (status: EvalStatus, summary: Record<string, unknown> | null, error: string | null, unreached = 0) => {
      await withEvalSession(this.ds, 'platform', (m) => m.getRepository(EvalRun).update(run.id, {
        status, summary, error, unreached, finishedAt: new Date(now.getTime() + Math.max(1, clock() - t0)),
      }));
      return { runId: run.id, status, dataset: base.dataset, summary, error };
    };

    try {
      // Could not run is a failed run with its reason, not an empty success.
      if (!profile) return finish('failed', null, 'embedding_not_configured: no embedding profile is active');
      if (profile.chunkerVersion !== CHUNKER_VERSION) {
        return finish('failed', null, `embedding_profile_mismatch: profile built with ${profile.chunkerVersion}, code builds ${CHUNKER_VERSION}`);
      }
      if (!this.runtime.available(profile)) {
        return finish('failed', null, `embedding_not_configured: the model files for ${profile.key} are not on this machine (EMBEDDING_MODEL_DIR)`);
      }
      const embedder = await this.runtime.forProfile(profile);
      const queries = opts.golden.queries;
      // Embedded once, outside any transaction, exactly as the api embeds a query.
      const vectors = await embedder.embed(queries.map((q) => profile.queryPrefix + q.text));

      const tenants = opts.tenants ?? await withEvalSession(this.ds, { spanning: 'retrieval: which accounts have vectors' },
        (m) => m.query(`SELECT DISTINCT "tenant_id" FROM "library_embedding" WHERE "profile_id" = $1 ORDER BY 1`, [profile.id])
          .then((rows: { tenant_id: string }[]) => rows.map((r) => r.tenant_id)));
      const libraries = new Map<string, TenantLibrary>();
      for (const t of tenants) libraries.set(t, await withEvalSession(this.ds, { tenantId: t }, (m) => this.library(m, profile.id)));

      const scores: QueryScore[] = [];
      const excluded: Record<string, number> = {};
      const results: Omit<EvalResult, 'id' | 'createdAt'>[] = [];
      const unreached: { tenant: string; query: string }[] = [];
      const isolation = { probes: 0, crossTenantHits: 0, breaches: [] as { query: string; asProbe: boolean }[] };
      const coverage = { sources: 0, indexed: 0, stale: 0 };
      for (const lib of libraries.values()) {
        coverage.sources += lib.coverage.sources; coverage.indexed += lib.coverage.indexed; coverage.stale += lib.coverage.stale;
      }
      const probe = opts.probeNearest ?? productionNearest;
      let pairs = 0;

      for (const tenant of tenants) {
        const lib = libraries.get(tenant)!;
        for (const [i, q] of queries.entries()) {
          if (pairs >= base.budgetSeries || overBudget()) { unreached.push({ tenant, query: q.id }); continue; }
          pairs += 1;
          const exclude = (reason: string, detail?: unknown) => {
            excluded[reason] = (excluded[reason] ?? 0) + 1;
            results.push(this.result(run.id, tenant, q.id, q.classSlug, { excluded: reason, ...(detail ? { detail } : {}) }));
          };
          if (!lib.coverage.indexed) { exclude('index_empty'); continue; }
          if (q.classSlug && !lib.classes.has(q.classSlug)) { exclude('class_absent'); continue; }
          const missing = q.expect.filter((e) => !lib.ids.has(keyOfExpectation(e)));
          if (missing.length) { exclude('expected_entry_absent', missing); continue; }

          const rows = await withEvalSession(this.ds, { tenantId: tenant },
            (m) => productionNearest(m, profile.id, vectors[i], MAX_RESULTS, q.classSlug ?? null));
          const ranked = rows.map((r) => r.source_id);
          const score = scoreQuery(q.expect.map((e) => lib.ids.get(keyOfExpectation(e))!), ranked);
          scores.push(score);
          results.push(this.result(run.id, tenant, q.id, q.classSlug, {
            ...score, returned: ranked.length, foundBy: { semantic: score.ranks.filter((r) => r !== null).length },
          }));

          // §3's isolation check: the same query as every other account and as one that
          // owns nothing. Anything returned that this account owns is a breach.
          const others = [...tenants.filter((t) => t !== tenant), ISOLATION_PROBE_TENANT];
          for (const other of others) {
            isolation.probes += 1;
            const seen = await withEvalSession(this.ds, { tenantId: other },
              (m) => probe(m, profile.id, vectors[i], MAX_RESULTS, q.classSlug ?? null));
            const hits = seen.filter((r) => lib.owned.has(r.source_id) || lib.owned.has(r.embedding_id)).length;
            if (hits) {
              isolation.crossTenantHits += hits;
              isolation.breaches.push({ query: q.id, asProbe: other === ISOLATION_PROBE_TENANT });
            }
          }
        }
      }

      for (const u of unreached) {
        results.push(this.result(run.id, u.tenant, u.query, queries.find((q) => q.id === u.query)?.classSlug, { unreached: 'budget_exhausted' }));
      }
      const byTenant = new Map<string, typeof results>();
      for (const r of results) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, rows] of byTenant) {
        await withEvalSession(this.ds, { tenantId }, (m) => m.getRepository(EvalResult).insert(rows));
      }

      const summary = {
        dataset: base.dataset, datasetNote: base.datasetNote,
        claim: base.dataset === 'seeded'
          ? 'smoke test: a smoke golden set over seeded library content proves the harness, not the retrieval; no quality claim is made'
          : 'measurement against an authored golden set; no acceptance target exists (QEVAL1 Q2), so only isolation is gated',
        accounts: tenants.length,
        pairs: { total: tenants.length * queries.length, scored: scores.length, excluded, unreached: unreached.length },
        metrics: aggregate(scores),
        foundBy: {
          semantic: scores.reduce((a, s) => a + s.ranks.filter((r) => r !== null).length, 0),
          lexical: null, exactIdentifier: null,
          reason: 'only semantic search is built (QEMB1, D47); the split exists for when the hybrid does',
        },
        coverage,
        isolation: {
          probes: isolation.probes, crossTenantHits: isolation.crossTenantHits,
          gate: isolation.crossTenantHits ? 'failed' : (isolation.probes ? 'passed' : 'not_run'),
          breaches: isolation.breaches,
        },
      };
      if (isolation.crossTenantHits) {
        return finish('failed', summary, `isolation_breach: ${isolation.crossTenantHits} hit(s) on another account's library`, unreached.length);
      }
      return finish(unreached.length ? 'budget_exhausted' : 'completed', summary, null, unreached.length);
    } catch (err) {
      this.logger.error(`retrieval eval failed: ${(err as Error).message}`);
      return finish('failed', null, (err as Error).message.slice(0, 2000));
    }
  }

  /** One account's library as the eval needs it: keys to ids, what it owns, how much of it is indexed. */
  private async library(m: EntityManager, profileId: string): Promise<TenantLibrary> {
    const modes = await m.getRepository(ClientEquipmentClassFailureMode).find();
    const recs = await m.getRepository(ClientEquipmentClassRecommendation).find();
    const stored: { id: string; source_id: string; input_hash: string }[] = await m.query(
      `SELECT "id", COALESCE("failure_mode_id", "recommendation_id") AS "source_id", "input_hash"
         FROM "library_embedding" WHERE "profile_id" = $1`, [profileId]);
    const modeOf = new Map(modes.map((fm) => [`${fm.clientEquipmentClassSlug}\u0000${fm.code}`, fm]));
    const ids = new Map<string, string>();
    const hashes = new Map<string, string>();
    for (const fm of modes) {
      ids.set(fmKey(fm.clientEquipmentClassSlug, fm.code), fm.id);
      hashes.set(fm.id, inputHash(failureModeText(fm)));
    }
    for (const r of recs) {
      ids.set(recKey(r.clientEquipmentClassSlug, r.failureModeCode, r.action), r.id);
      hashes.set(r.id, inputHash(recommendationText(r, modeOf.get(`${r.clientEquipmentClassSlug}\u0000${r.failureModeCode}`))));
    }
    const storedBySource = new Map(stored.map((s) => [s.source_id, s.input_hash]));
    const fresh = [...hashes].filter(([id, h]) => storedBySource.get(id) === h).length;
    return {
      ids,
      classes: new Set([...modes.map((x) => x.clientEquipmentClassSlug), ...recs.map((x) => x.clientEquipmentClassSlug)]),
      owned: new Set([...hashes.keys(), ...stored.map((s) => s.id)]),
      coverage: { sources: hashes.size, indexed: stored.length, stale: hashes.size - fresh },
    };
  }

  private result(runId: string, tenantId: string, queryId: string, classSlug: string | undefined, metrics: Record<string, unknown>) {
    // The library has no machine: the "where" of a retrieval result is the class it asked about.
    return { runId, tenantId, sourceSystem: 'library', externalId: classSlug ?? '*', subject: queryId, variant: 'retrieval', metrics };
  }
}
