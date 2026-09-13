import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Credentials, sessions and the record of what happened to an account (task P1-88).
 *
 * All three carry the isolation policy, which was not the first plan. Every one of
 * them is read before a tenant is known — a sign-in starts with an email address and
 * nothing else — so the first version exempted them, and the derived coverage check
 * refused to let that pass quietly. It was right to: the credential service already
 * runs tenant-spanning, so the policy costs nothing on the paths that need to look
 * across accounts, and it still stops a tenant session from reading another account's
 * sessions or invitations. The exemption would have been a habit rather than a reason.
 *
 * `user_security_event` keeps a nullable tenant, because a failed login for an address
 * nobody owns has no account to attribute it to — and that row is the single most
 * useful one in the table. A null never equals anything, so those rows are invisible
 * from inside every account, the same property the device pool relies on.
 *
 * Tokens are stored as SHA-256 rather than bcrypt. They are 256 bits of randomness,
 * so there is nothing to guess and no dictionary to slow down; what matters is that a
 * database dump contains nothing anybody can present. Passwords are bcrypt, because a
 * password is chosen by a human and therefore guessable.
 */
export class Credentials1757740000000 implements MigrationInterface {
  name = 'Credentials1757740000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "app_user" ADD COLUMN "failed_attempts" int NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "app_user" ADD COLUMN "locked_until" timestamptz`);

    await q.query(`
      CREATE TABLE "user_invitation" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "purpose" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_user_invitation_token" ON "user_invitation" ("token_hash")`);
    await q.query(`
      CREATE INDEX "ix_user_invitation_user" ON "user_invitation" ("tenant_id", "user_id", "consumed_at")`);
    await q.query(`
      ALTER TABLE "user_invitation" ADD CONSTRAINT "ck_user_invitation_purpose"
        CHECK ("purpose" IN ('invite', 'reset'))`);

    await q.query(`
      CREATE TABLE "user_session" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "family" uuid NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "rotated_at" timestamptz,
        "revoked_at" timestamptz,
        "revoked_reason" text,
        "user_agent" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_user_session_token" ON "user_session" ("token_hash")`);
    await q.query(`CREATE INDEX "ix_user_session_user" ON "user_session" ("tenant_id", "user_id", "revoked_at")`);
    // Revocation walks the family, so that is the access path that has to be fast:
    // detecting a stolen token is worth nothing if acting on it is a table scan.
    await q.query(`CREATE INDEX "ix_user_session_family" ON "user_session" ("family")`);

    await q.query(`
      CREATE TABLE "user_security_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text,
        "user_id" uuid,
        "email_attempted" text,
        "type" text NOT NULL,
        "detail" text,
        "ip_address" text,
        "user_agent" text,
        "at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX "ix_user_security_event_user" ON "user_security_event" ("user_id", "at")`);
    await q.query(`CREATE INDEX "ix_user_security_event_type" ON "user_security_event" ("type", "at")`);

    for (const table of ['user_invitation', 'user_session', 'user_security_event']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )
          WITH CHECK (
            current_setting('ta.bypass', true) = 'on'
            OR "tenant_id" = current_setting('ta.tenant_id', true)
          )`);
    }

    // The application needs delete on the first two for housekeeping, and none at all
    // on the third: a security log its subject can erase is not a security log.
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "user_invitation" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "user_session" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "user_security_event" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "user_security_event"`);
    await q.query(`DROP TABLE IF EXISTS "user_session"`);
    await q.query(`DROP TABLE IF EXISTS "user_invitation"`);
    await q.query(`ALTER TABLE "app_user" DROP COLUMN IF EXISTS "locked_until"`);
    await q.query(`ALTER TABLE "app_user" DROP COLUMN IF EXISTS "failed_attempts"`);
  }
}
