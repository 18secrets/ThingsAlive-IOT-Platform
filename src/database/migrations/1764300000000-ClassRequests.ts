import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An account asking Things Alive for an equipment class the library does not have
 * (test report OB-6). Until now that request went by phone or email, and nobody on
 * either side could see whether it had been heard.
 *
 * One row per request, owned by the account that made it. Things Alive staff work the
 * queue across accounts: new → in_progress → published (naming the class that answers
 * it) or declined (saying why). Both ends are final.
 *
 * The rules that make the status mean something are here, not only in the service: a
 * "published" with no class to go and look at, or a "declined" with no reason, is a
 * dead end for the account that asked, whoever wrote the row.
 */
export class ClassRequests1764300000000 implements MigrationInterface {
  name = 'ClassRequests1764300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "class_request" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "machine_type" text NOT NULL,
        "manufacturer" text,
        "model" text,
        "signals" text[] NOT NULL DEFAULT '{}',
        "note" text,
        "status" text NOT NULL DEFAULT 'new',
        "staff_note" text,
        "published_class_slug" text,
        "requested_by" text NOT NULL,
        "decided_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_class_request_status" CHECK ("status" IN ('new', 'in_progress', 'published', 'declined')),
        CONSTRAINT "ck_class_request_machine_type" CHECK (length(btrim("machine_type")) BETWEEN 2 AND 120),
        CONSTRAINT "ck_class_request_published" CHECK ("status" <> 'published' OR "published_class_slug" IS NOT NULL),
        CONSTRAINT "ck_class_request_declined" CHECK ("status" <> 'declined' OR length(btrim(coalesce("staff_note", ''))) > 0)
      )`);
    await q.query(`CREATE INDEX "ix_class_request_tenant" ON "class_request" ("tenant_id", "created_at" DESC)`);
    // The staff queue reads open requests oldest first, across accounts.
    await q.query(`CREATE INDEX "ix_class_request_open" ON "class_request" ("created_at") WHERE "status" IN ('new', 'in_progress')`);

    // Published and declined are final: reopening one would tell the account its answer
    // changed without anyone deciding again. A new request is how to ask again.
    await q.query(`
      CREATE FUNCTION "class_request_final"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."status" IN ('published', 'declined') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
          RAISE EXCEPTION 'ck_class_request_final: request % is already %; make a new request instead.', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_class_request_final';
        END IF;
        NEW."updated_at" := now();
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_class_request_final" BEFORE UPDATE ON "class_request"
        FOR EACH ROW EXECUTE FUNCTION "class_request_final"()`);

    await q.query(`ALTER TABLE "class_request" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "class_request" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "class_request"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    // No delete: a request that was made stays on record, answered or not.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "class_request" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "class_request"`);
    await q.query(`DROP FUNCTION IF EXISTS "class_request_final"()`);
  }
}
