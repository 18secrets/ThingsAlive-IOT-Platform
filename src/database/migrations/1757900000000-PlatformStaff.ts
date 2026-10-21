import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A real, revocable credential for Things Alive staff.
 *
 * Every platform-role token before this migration was minted by a CLI script and
 * never touched the database — no row, no password, nothing to suspend. Neither
 * table here carries a tenant_id or a row-level-security policy: a platform user is
 * not tenant data, the same reason `tenant` itself carries no tenant column. Access
 * control for these two tables is by GRANT alone, exactly like `tenant`.
 */
export class PlatformStaff1757900000000 implements MigrationInterface {
  name = 'PlatformStaff1757900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "platform_user" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" text NOT NULL,
        "full_name" text NOT NULL,
        "role" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "password_hash" text NOT NULL,
        "failed_attempts" int NOT NULL DEFAULT 0,
        "locked_until" timestamptz,
        "suspended_at" timestamptz,
        "suspended_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_platform_user_email" ON "platform_user" ("email")`);
    await q.query(`
      ALTER TABLE "platform_user" ADD CONSTRAINT "ck_platform_user_status"
        CHECK ("status" IN ('active', 'suspended'))`);
    await q.query(`
      ALTER TABLE "platform_user" ADD CONSTRAINT "ck_platform_user_role"
        CHECK ("role" IN ('master-admin', 'platform-support', 'catalog-author'))`);

    await q.query(`
      CREATE TABLE "platform_session" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "platform_user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "family" uuid NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "rotated_at" timestamptz,
        "revoked_at" timestamptz,
        "revoked_reason" text,
        "user_agent" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_platform_session_token" ON "platform_session" ("token_hash")`);
    await q.query(`
      CREATE INDEX "ix_platform_session_user" ON "platform_session" ("platform_user_id", "revoked_at")`);
    await q.query(`CREATE INDEX "ix_platform_session_family" ON "platform_session" ("family")`);

    await q.query(`GRANT SELECT, INSERT, UPDATE ON "platform_user" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_session" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "platform_session"`);
    await q.query(`DROP TABLE IF EXISTS "platform_user"`);
  }
}
