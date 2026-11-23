import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Library models are given to accounts, as classes are (TC_234, 20 Nov 2026).
 *
 * `equipment_template` was built as onboarding convenience with "no entitlement, no
 * tenant", so every account's "Copy a library model" list showed every model in the
 * library: a pump account picking from diesel generators, and each account seeing the
 * models Things Alive had made for somebody else. Master Admin now says which models
 * an account is given, the way it says which classes.
 *
 * - `equipment_template_grant` is the fault code grant's shape (FaultCodeLibrary
 *   1765300000000): platform-owned, one row per account and model, revoked rather than
 *   deleted. An account reads its own rows; the policy's WITH CHECK admits only the
 *   tenant-spanning session, so no account can give itself a model by any route.
 * - A copy names the model it came from (`copied_from_id`), and from here the database
 *   refuses a copy of a model the account was not given. A check in the service alone
 *   loses to a revoke committed between the check and the insert; the trigger reads the
 *   grant FOR SHARE, so a revoke racing a copy waits for it instead.
 * - Revoking takes nothing back. A copy is the account's (D04), and a machine may already
 *   read its ratings from it.
 *
 * Day one: an account is given each model it already holds a copy of. It has those
 * models already, so the grant shows it nothing new; every other account starts with
 * none until Master Admin gives it some.
 */
export class ModelGrants1766000000000 implements MigrationInterface {
  name = 'ModelGrants1766000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "equipment_template_grant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        -- A foreign key, unlike a copy's copied_from_id: a copy outlives its model, but a
        -- grant of a model that is gone gives nothing and would only look like it does.
        "template_id" uuid NOT NULL REFERENCES "equipment_template" ("id") ON DELETE CASCADE,
        "granted_by" text NOT NULL,
        "granted_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revoked_by" text,
        "note" text,
        -- One row per account and model: granting again reuses it, so an account keeps
        -- one history per model, as class entitlements and fault code grants do.
        CONSTRAINT "uq_equipment_template_grant" UNIQUE ("tenant_id", "template_id"),
        CONSTRAINT "ck_equipment_template_grant_revoked" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
      )`);
    await q.query(`ALTER TABLE "equipment_template_grant" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "equipment_template_grant" FORCE ROW LEVEL SECURITY`);
    // Read: the account's own rows. Write: the tenant-spanning session only — which
    // models an account has been given is not the account's to change.
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "equipment_template_grant"
        USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
        WITH CHECK (current_setting('ta.bypass', true) = 'on')`);
    // UPDATE as well as SELECT: the copy trigger reads the grant FOR SHARE, which
    // Postgres allows only to a role that may update the row.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "equipment_template_grant" TO "ta_app"`);

    // SECURITY INVOKER (the default), on purpose: the grant is read in the copying
    // account's own session, where row security shows it its own grants and nobody
    // else's. Another account's grant of the same model cannot let this one through.
    await q.query(`
      CREATE FUNCTION "client_equipment_template_granted"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."copied_from_id" IS NULL THEN
          RETURN NEW;
        END IF;
        PERFORM 1 FROM "equipment_template_grant" g
          WHERE g."tenant_id" = NEW."tenant_id" AND g."template_id" = NEW."copied_from_id" AND g."revoked_at" IS NULL
          FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Library model % is not given to account %.', NEW."copied_from_id", NEW."tenant_id"
            USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'model_not_granted';
        END IF;
        RETURN NEW;
      END $$`);
    // Insert, and an update that changes where a copy came from: a copy re-pointed at a
    // model the account was not given is the same copy by another route.
    await q.query(`
      CREATE TRIGGER "client_equipment_template_granted"
        BEFORE INSERT OR UPDATE OF "copied_from_id" ON "client_equipment_template"
        FOR EACH ROW EXECUTE FUNCTION "client_equipment_template_granted"()`);

    // client_equipment_template forces row-level security; without the bypass a
    // migration not run as a superuser would see no account's copies and grant nothing.
    await q.query(`SET LOCAL "ta.bypass" = 'on'`);
    await q.query(`
      INSERT INTO "equipment_template_grant" ("tenant_id", "template_id", "granted_by", "note")
      SELECT DISTINCT c."tenant_id", c."copied_from_id", 'migration', 'Day one: the account already held a copy'
        FROM "client_equipment_template" c
        JOIN "equipment_template" t ON t."id" = c."copied_from_id"
      ON CONFLICT DO NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "client_equipment_template_granted" ON "client_equipment_template"`);
    await q.query(`DROP FUNCTION IF EXISTS "client_equipment_template_granted"()`);
    await q.query(`DROP TABLE IF EXISTS "equipment_template_grant"`);
  }
}
