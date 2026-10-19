import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the assistant has spent, per account per day (task QCHAT1).
 *
 * The only thing the assistant stores. Conversations are not kept: the browser sends
 * the turns it has, and nothing a person typed outlives the request. This row is the
 * budget — tokens and requests per UTC day — so one account's chat cannot spend
 * everybody's Vertex quota, and so "what did the assistant cost last month" has an
 * answer that is not a guess.
 *
 * Counters only go up, and the CHECKs say so: a negative total is a bug that would
 * hand an account more budget than it has, and the database is where that is refused.
 */
export class AssistantUsage1760600000000 implements MigrationInterface {
  name = 'AssistantUsage1760600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "assistant_usage" (
        "tenant_id" text NOT NULL,
        "day" date NOT NULL,
        "tokens" bigint NOT NULL DEFAULT 0,
        "requests" integer NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "day"),
        CONSTRAINT "ck_assistant_usage_tokens" CHECK ("tokens" >= 0),
        CONSTRAINT "ck_assistant_usage_requests" CHECK ("requests" >= 0)
      )`);
    await q.query(`ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "assistant_usage" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "assistant_usage"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    // No DELETE: a day's spend is a record, and clearing it is how a budget gets reset
    // by accident.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "assistant_usage" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "assistant_usage"`);
  }
}
