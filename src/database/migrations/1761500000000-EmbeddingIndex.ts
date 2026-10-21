import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Embeddings for the library, without pgvector (task QEMB1; D08, D09, D19, D47).
 *
 * - `embedding_profile` — the pinned model (D08). Platform-owned, one immutable row per
 *   exact build: nothing changes except `status`, and only `active` → `retired`; never
 *   deleted. Every stored vector names the profile that made it, and a row that could
 *   change would silently re-label every vector already stored. At most one `active`, by
 *   a partial unique index, because a service check loses to a concurrent write. The
 *   third model registry, apart from `llm_provider_config` and `forecast_model`.
 *
 *   The seeded row is BAAI's bge-small-en-v1.5 at revision 5c38ec7c…, fp32 ONNX, whose
 *   model card at that revision declares MIT. The two hashes are the files the image bakes
 *   (scripts/fetch-embedding-model.js checks the same values); the service refuses to
 *   embed with weights that do not hash to `weights_sha256`.
 *
 * - `library_embedding` — one vector per library entry per profile, tenant-owned. `real[]`
 *   rather than pgvector's `vector`, because Railway's standard Postgres image does not
 *   carry the extension and a tenant's library is hundreds of rows (D47). Moving later is
 *   a new column and an index; these values do not change.
 *
 *   The source is a real foreign key, one column per kind, and it carries the tenant: the
 *   failure-mode and recommendation copies get a unique `(tenant_id, id)` here so the key
 *   can be composite. A vector therefore cannot point at another account's row, and
 *   deleting the entry deletes its vector — an orphan would be a search hit for content
 *   that no longer exists.
 *
 *   What a CHECK cannot see is a trigger: the vector's length against its profile's
 *   dimension, its norm (the dot product is the cosine only for unit vectors), and the
 *   profile being active.
 *
 * - `library_embedding_nearest` — the only comparison. It reads one profile's rows and
 *   refuses a query of another length, so vectors from two profiles are never compared;
 *   SECURITY INVOKER, so row-level security applies to it exactly as to a query.
 */
export class EmbeddingIndex1761500000000 implements MigrationInterface {
  name = 'EmbeddingIndex1761500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "embedding_profile" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" text NOT NULL,
        "model_repo" text NOT NULL,
        "revision" text NOT NULL,
        "runtime" text NOT NULL,
        "weights_file" text NOT NULL,
        "weights_sha256" text NOT NULL,
        "tokenizer_sha256" text NOT NULL,
        "dimension" int NOT NULL,
        "pooling" text NOT NULL,
        "normalization" text NOT NULL,
        "distance" text NOT NULL,
        "query_prefix" text NOT NULL,
        "max_tokens" int NOT NULL,
        "language" text NOT NULL,
        "chunker_version" text NOT NULL,
        "license" text NOT NULL,
        "status" text NOT NULL,
        "approved_by" text NOT NULL,
        "approved_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_embedding_profile_build" UNIQUE ("key", "revision", "weights_sha256", "chunker_version"),
        CONSTRAINT "ck_embedding_profile_runtime" CHECK ("runtime" IN ('onnx-cpu')),
        CONSTRAINT "ck_embedding_profile_sha" CHECK ("weights_sha256" ~ '^[0-9a-f]{64}$' AND "tokenizer_sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_embedding_profile_dimension" CHECK ("dimension" > 0 AND "max_tokens" > 0),
        CONSTRAINT "ck_embedding_profile_pooling" CHECK ("pooling" IN ('cls', 'mean')),
        -- Only unit vectors: the search is a dot product, and that is the cosine only
        -- when both sides have length one.
        CONSTRAINT "ck_embedding_profile_normalization" CHECK ("normalization" = 'l2'),
        CONSTRAINT "ck_embedding_profile_distance" CHECK ("distance" = 'cosine'),
        CONSTRAINT "ck_embedding_profile_status" CHECK ("status" IN ('active', 'retired'))
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_embedding_profile_one_active" ON "embedding_profile" ((true)) WHERE "status" = 'active'`);
    await q.query(`
      CREATE FUNCTION "embedding_profile_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'embedding_profile %: a profile vectors were made with is never deleted', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
          RAISE EXCEPTION 'embedding_profile %: a profile is immutable; only its status changes', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'active' AND NEW."status" = 'retired') THEN
          RAISE EXCEPTION 'embedding_profile %: status moves active -> retired only', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_embedding_profile_guard" BEFORE UPDATE OR DELETE ON "embedding_profile"
        FOR EACH ROW EXECUTE FUNCTION "embedding_profile_guard"()`);
    await q.query(`
      INSERT INTO "embedding_profile"
        ("key", "model_repo", "revision", "runtime", "weights_file", "weights_sha256", "tokenizer_sha256",
         "dimension", "pooling", "normalization", "distance", "query_prefix", "max_tokens", "language",
         "chunker_version", "license", "status", "approved_by", "approved_at")
      VALUES ('bge-small-en-v1.5', 'BAAI/bge-small-en-v1.5', '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a', 'onnx-cpu',
              'onnx/model.onnx', '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
              'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
              384, 'cls', 'l2', 'cosine', 'Represent this sentence for searching relevant passages: ', 512, 'en',
              'library-entry@1', 'mit', 'active', 'Tapas (QEMB1, recorded as D47)', '2026-10-20T00:00:00Z')`);
    // Read by the embedder and the search; written only by migrations and the guarded status move.
    await q.query(`GRANT SELECT ON "embedding_profile" TO "ta_app"`);

    // The targets of the composite keys below. (tenant_id, id) is unique already, because
    // id is; the index exists so a foreign key can name both columns.
    await q.query(`CREATE UNIQUE INDEX "uq_client_failure_mode_tenant_id" ON "client_equipment_class_failure_mode" ("tenant_id", "id")`);
    await q.query(`CREATE UNIQUE INDEX "uq_client_recommendation_tenant_id" ON "client_equipment_class_recommendation" ("tenant_id", "id")`);

    await q.query(`
      CREATE TABLE "library_embedding" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "profile_id" uuid NOT NULL REFERENCES "embedding_profile" ("id"),
        "source_kind" text NOT NULL,
        "failure_mode_id" uuid,
        "recommendation_id" uuid,
        "input_hash" text NOT NULL,
        "vector" real[] NOT NULL,
        "indexed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_library_embedding_kind" CHECK ("source_kind" IN ('failure_mode', 'recommendation')),
        CONSTRAINT "ck_library_embedding_source" CHECK (
          ("source_kind" = 'failure_mode') = ("failure_mode_id" IS NOT NULL)
          AND ("source_kind" = 'recommendation') = ("recommendation_id" IS NOT NULL)),
        CONSTRAINT "ck_library_embedding_hash" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_library_embedding_vector_shape"
          CHECK (array_ndims("vector") = 1 AND array_position("vector", NULL) IS NULL),
        CONSTRAINT "fk_library_embedding_failure_mode"
          FOREIGN KEY ("tenant_id", "failure_mode_id")
          REFERENCES "client_equipment_class_failure_mode" ("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "fk_library_embedding_recommendation"
          FOREIGN KEY ("tenant_id", "recommendation_id")
          REFERENCES "client_equipment_class_recommendation" ("tenant_id", "id") ON DELETE CASCADE
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_library_embedding_source" ON "library_embedding"
        ("tenant_id", "profile_id", "source_kind", COALESCE("failure_mode_id", "recommendation_id"))`);
    await q.query(`CREATE INDEX "ix_library_embedding_profile" ON "library_embedding" ("tenant_id", "profile_id")`);

    await q.query(`
      CREATE FUNCTION "library_embedding_vector_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        p "embedding_profile"%ROWTYPE;
        norm double precision;
      BEGIN
        SELECT * INTO p FROM "embedding_profile" WHERE "id" = NEW."profile_id";
        IF p."status" IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'library_embedding: profile % is %, and only the active profile is indexed', NEW."profile_id", p."status"
            USING ERRCODE = 'check_violation';
        END IF;
        IF coalesce(array_length(NEW."vector", 1), 0) <> p."dimension" THEN
          RAISE EXCEPTION 'library_embedding: a vector of % elements under a profile of dimension %',
            coalesce(array_length(NEW."vector", 1), 0), p."dimension"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT sum(x::double precision * x::double precision) INTO norm FROM unnest(NEW."vector") AS t(x);
        IF abs(norm - 1) > 1e-3 THEN
          RAISE EXCEPTION 'library_embedding: the vector is not unit length (squared norm %)', norm
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_library_embedding_vector_guard" BEFORE INSERT OR UPDATE ON "library_embedding"
        FOR EACH ROW EXECUTE FUNCTION "library_embedding_vector_guard"()`);

    await q.query(`ALTER TABLE "library_embedding" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "library_embedding" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "library_embedding"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    // No DELETE: a vector goes when its entry goes, by the cascade, and an edited entry
    // is re-embedded in place.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "library_embedding" TO "ta_app"`);

    await q.query(`
      CREATE FUNCTION "library_embedding_nearest"(p_profile uuid, p_query real[], p_k int, p_class text DEFAULT NULL)
      RETURNS TABLE ("embedding_id" uuid, "source_kind" text, "source_id" uuid, "rank" int)
      LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
      DECLARE
        dim int;
      BEGIN
        SELECT p."dimension" INTO dim FROM "embedding_profile" p WHERE p."id" = p_profile;
        IF dim IS NULL THEN
          RAISE EXCEPTION 'library_embedding_nearest: no profile %', p_profile USING ERRCODE = 'check_violation';
        END IF;
        IF coalesce(array_length(p_query, 1), 0) <> dim OR array_ndims(p_query) <> 1 THEN
          RAISE EXCEPTION 'library_embedding_nearest: a query of % elements against a profile of dimension %',
            coalesce(array_length(p_query, 1), 0), dim USING ERRCODE = 'check_violation';
        END IF;
        IF p_k IS NULL OR p_k < 1 OR p_k > 30 THEN
          RAISE EXCEPTION 'library_embedding_nearest: k must be 1 to 30, not %', p_k USING ERRCODE = 'check_violation';
        END IF;
        RETURN QUERY
          SELECT scored."id", scored."source_kind", scored."source_id",
                 (row_number() OVER (ORDER BY scored."score" DESC, scored."id"))::int
            FROM (
              SELECT e."id", e."source_kind", COALESCE(e."failure_mode_id", e."recommendation_id") AS "source_id",
                     (SELECT sum(a * b) FROM unnest(e."vector", p_query) AS t(a, b)) AS "score"
                FROM "library_embedding" e
                LEFT JOIN "client_equipment_class_failure_mode" fm ON fm."id" = e."failure_mode_id"
                LEFT JOIN "client_equipment_class_recommendation" r ON r."id" = e."recommendation_id"
               WHERE e."profile_id" = p_profile
                 AND (p_class IS NULL OR COALESCE(fm."client_equipment_class_slug", r."client_equipment_class_slug") = p_class)
            ) scored
           ORDER BY scored."score" DESC, scored."id"
           LIMIT p_k;
      END $$`);
    await q.query(`GRANT EXECUTE ON FUNCTION "library_embedding_nearest"(uuid, real[], int, text) TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION IF EXISTS "library_embedding_nearest"(uuid, real[], int, text)`);
    await q.query(`DROP TABLE IF EXISTS "library_embedding"`);
    await q.query(`DROP FUNCTION IF EXISTS "library_embedding_vector_guard"()`);
    await q.query(`DROP INDEX IF EXISTS "uq_client_recommendation_tenant_id"`);
    await q.query(`DROP INDEX IF EXISTS "uq_client_failure_mode_tenant_id"`);
    await q.query(`DROP TABLE IF EXISTS "embedding_profile"`);
    await q.query(`DROP FUNCTION IF EXISTS "embedding_profile_guard"()`);
  }
}
