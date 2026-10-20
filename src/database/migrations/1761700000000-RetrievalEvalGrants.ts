import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the retrieval eval reads (task QEVAL1b; G10).
 *
 * `Evaluation1761300000000` left each later part to grant `ta_eval` what that part reads,
 * in its own migration, so the role never holds more than the evals that exist use. The
 * retrieval eval reads the active embedding profile, the vectors, the library rows they
 * describe, and calls the one comparison QEMB1 allows. All of it is SELECT or EXECUTE of
 * a SECURITY INVOKER function: the eval can search the index as an account sees it and
 * can neither build nor change it, so a run cannot reindex or leave a vector behind.
 */
export class RetrievalEvalGrants1761700000000 implements MigrationInterface {
  name = 'RetrievalEvalGrants1761700000000';

  private readonly reads = [
    'embedding_profile', 'library_embedding',
    'client_equipment_class_failure_mode', 'client_equipment_class_recommendation',
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const table of this.reads) await q.query(`GRANT SELECT ON "${table}" TO "ta_eval"`);
    await q.query(`GRANT EXECUTE ON FUNCTION "library_embedding_nearest"(uuid, real[], int, text) TO "ta_eval"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE EXECUTE ON FUNCTION "library_embedding_nearest"(uuid, real[], int, text) FROM "ta_eval"`);
    for (const table of this.reads) await q.query(`REVOKE SELECT ON "${table}" FROM "ta_eval"`);
  }
}
