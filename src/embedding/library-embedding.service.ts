import {
  ForbiddenException, Inject, Injectable, InternalServerErrorException, ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';
import { withTenantSession } from '../scope/tenant-session';
import { EMBEDDING_RUNTIME, Embedder, EmbeddingProfileMismatch, EmbeddingRuntime } from './embedder';
import { EmbeddingProfile, LibraryEmbedding, LibrarySourceKind } from './embedding.entities';
import { CHUNKER_VERSION, failureModeText, inputHash, recommendationText } from './library-text';

/** Small enough that one batch never holds the model for long; the measured rate barely moves above it. */
const BATCH = 16;
export const MAX_RESULTS = 30;

interface Source {
  kind: LibrarySourceKind;
  id: string;
  classSlug: string;
  code: string;
  title: string;
  text: string;
  hash: string;
}

export interface ProfileRef { key: string; revision: string; id: string }

export interface ReindexResult {
  profile: ProfileRef;
  sources: number;
  embedded: number;
  unchanged: number;
}

export interface SearchHit {
  rank: number;
  kind: LibrarySourceKind;
  id: string;
  classSlug: string;
  /** The failure mode's code; for a recommendation, the code of the mode it addresses. */
  code: string;
  title: string;
  text: string;
}

export interface SearchResult {
  profile: ProfileRef;
  method: 'semantic';
  hits: SearchHit[];
  coverage: { sources: number; indexed: number; stale: number };
}

/**
 * Semantic search over the account's own library copies (task QEMB1, D47).
 *
 * Vectors are `real[]` and the comparison is exhaustive, in the database, under the same
 * row-level security as the rows they describe (D09). Only ranks leave this service: a
 * similarity between 0 and 1 beside a maintenance answer is read as a confidence, and it
 * is not one (G07; shared contract §4).
 */
@Injectable()
export class LibraryEmbeddingService {
  constructor(
    private readonly ds: DataSource,
    @Inject(EMBEDDING_RUNTIME) private readonly runtime: EmbeddingRuntime,
  ) {}

  async reindex(scope: RequestScope): Promise<ReindexResult> {
    this.requireAccount(scope);
    const profile = await this.activeProfile();
    const embedder = await this.embedderFor(profile);
    return withTenantSession(this.ds, scope, async (m) => {
      // Two reindexes of one account wait for each other rather than both running the
      // model over the same entries; the second then finds nothing changed. The lock is
      // the transaction's, so a crash cannot leave it held.
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('library_embedding:' || $1, 0))`, [scope.tenantId]);
      const sources = await this.sources(m);
      const stored = await this.storedHashes(m, profile.id);
      const changed = sources.filter((s) => stored.get(key(s.kind, s.id)) !== s.hash);

      for (let i = 0; i < changed.length; i += BATCH) {
        const batch = changed.slice(i, i + BATCH);
        const vectors = await embedder.embed(batch.map((s) => s.text));
        for (let j = 0; j < batch.length; j++) {
          const s = batch[j];
          await m.query(
            `INSERT INTO "library_embedding"
               ("tenant_id", "profile_id", "source_kind", "failure_mode_id", "recommendation_id", "input_hash", "vector")
             VALUES ($1, $2, $3, $4, $5, $6, $7::real[])
             ON CONFLICT ("tenant_id", "profile_id", "source_kind", COALESCE("failure_mode_id", "recommendation_id"))
             DO UPDATE SET "vector" = EXCLUDED."vector", "input_hash" = EXCLUDED."input_hash", "indexed_at" = now()
               WHERE "library_embedding"."input_hash" IS DISTINCT FROM EXCLUDED."input_hash"`,
            [scope.tenantId, profile.id, s.kind, s.kind === 'failure_mode' ? s.id : null,
              s.kind === 'recommendation' ? s.id : null, s.hash, vectors[j]],
          );
        }
      }
      return { profile: ref(profile), sources: sources.length, embedded: changed.length, unchanged: sources.length - changed.length };
    });
  }

  async search(scope: RequestScope, query: string, limit = MAX_RESULTS, classSlug?: string): Promise<SearchResult> {
    this.requireAccount(scope);
    const profile = await this.activeProfile();
    const embedder = await this.embedderFor(profile);
    // Embedded before the transaction opens: the model's time is not a held connection.
    const [vector] = await embedder.embed([profile.queryPrefix + query]);
    return withTenantSession(this.ds, scope, async (m) => {
      const rows: { source_kind: LibrarySourceKind; source_id: string; rank: number }[] = await m.query(
        `SELECT "source_kind", "source_id", "rank" FROM library_embedding_nearest($1, $2::real[], $3, $4) ORDER BY "rank"`,
        [profile.id, vector, Math.min(Math.max(1, limit), MAX_RESULTS), classSlug ?? null],
      );
      const sources = await this.sources(m);
      const byKey = new Map(sources.map((s) => [key(s.kind, s.id), s]));
      const stored = await this.storedHashes(m, profile.id);
      const indexed = sources.filter((s) => stored.has(key(s.kind, s.id))).length;
      const fresh = sources.filter((s) => stored.get(key(s.kind, s.id)) === s.hash).length;
      return {
        profile: ref(profile),
        method: 'semantic' as const,
        hits: rows.map((r) => {
          const s = byKey.get(key(r.source_kind, r.source_id));
          return {
            rank: r.rank, kind: r.source_kind, id: r.source_id,
            classSlug: s?.classSlug ?? '', code: s?.code ?? '', title: s?.title ?? '', text: s?.text ?? '',
          };
        }),
        coverage: { sources: sources.length, indexed, stale: sources.length - fresh },
      };
    });
  }

  /**
   * Every library entry is an account's, so staff have nothing to search: an empty
   * answer would read as "your library has nothing on this", confidently wrong.
   */
  private requireAccount(scope: RequestScope): void {
    if (scope.isPlatformRole || !scope.tenantId) {
      throw new ForbiddenException('The library is searched inside one account. Open it as that account\'s user.');
    }
  }

  private async activeProfile(): Promise<EmbeddingProfile> {
    const profile = await this.ds.getRepository(EmbeddingProfile).findOne({ where: { status: 'active' } });
    if (!profile) {
      throw new ServiceUnavailableException({ code: 'embedding_not_configured', message: 'No embedding profile is active.' });
    }
    // The text this code builds must be the text the profile says its vectors were made
    // from; otherwise new vectors and old ones describe different inputs under one id.
    if (profile.chunkerVersion !== CHUNKER_VERSION) {
      throw new InternalServerErrorException({
        code: 'embedding_profile_mismatch',
        message: `The active profile was built with ${profile.chunkerVersion}; this code builds ${CHUNKER_VERSION}.`,
      });
    }
    return profile;
  }

  private async embedderFor(profile: EmbeddingProfile): Promise<Embedder> {
    if (!this.runtime.available(profile)) {
      throw new ServiceUnavailableException({
        code: 'embedding_not_configured',
        message: `The model files for ${profile.key} are not on this server (EMBEDDING_MODEL_DIR).`,
      });
    }
    try {
      return await this.runtime.forProfile(profile);
    } catch (err) {
      if (err instanceof EmbeddingProfileMismatch) {
        throw new InternalServerErrorException({ code: 'embedding_profile_mismatch', message: err.message });
      }
      throw err;
    }
  }

  private async sources(m: EntityManager): Promise<Source[]> {
    const modes = await m.getRepository(ClientEquipmentClassFailureMode).find({ order: { id: 'ASC' } });
    const recs = await m.getRepository(ClientEquipmentClassRecommendation).find({ order: { id: 'ASC' } });
    const modeOf = new Map(modes.map((fm) => [`${fm.clientEquipmentClassSlug}\u0000${fm.code}`, fm]));
    const out: Source[] = modes.map((fm) => {
      const text = failureModeText(fm);
      return { kind: 'failure_mode', id: fm.id, classSlug: fm.clientEquipmentClassSlug, code: fm.code, title: fm.name, text, hash: inputHash(text) };
    });
    for (const r of recs) {
      const text = recommendationText(r, modeOf.get(`${r.clientEquipmentClassSlug}\u0000${r.failureModeCode}`));
      out.push({
        kind: 'recommendation', id: r.id, classSlug: r.clientEquipmentClassSlug, code: r.failureModeCode,
        title: r.action, text, hash: inputHash(text),
      });
    }
    return out;
  }

  private async storedHashes(m: EntityManager, profileId: string): Promise<Map<string, string>> {
    const rows = await m.getRepository(LibraryEmbedding).find({
      where: { profileId }, select: { sourceKind: true, failureModeId: true, recommendationId: true, inputHash: true },
    });
    return new Map(rows.map((r) => [key(r.sourceKind, (r.failureModeId ?? r.recommendationId)!), r.inputHash]));
  }
}

const key = (kind: LibrarySourceKind, id: string) => `${kind}:${id}`;
const ref = (p: EmbeddingProfile): ProfileRef => ({ id: p.id, key: p.key, revision: p.revision });
