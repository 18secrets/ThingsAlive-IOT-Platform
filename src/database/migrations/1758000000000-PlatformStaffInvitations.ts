import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The invite path onto `platform_user` (task QPA2).
 *
 * `1757900000000-PlatformStaff.ts` is already committed, so this alters rather than
 * replaces it: `password_hash` was `NOT NULL` because every row that existed was
 * created with one already set (`staff-bootstrap.ts`, `create-platform-user.ts`).
 * Inviting is a row that exists before a password does, the same reason
 * `app_user.password_hash` is nullable — a null hash is not "any password works"
 * anywhere in this codebase, `PasswordService.verify` refuses it outright.
 *
 * `platform_invitation` is `user_invitation`'s counterpart, minus `tenant_id` and
 * `purpose`: a platform invitation is not tenant data (no RLS, same as `platform_user`
 * and `platform_session`), and staff have no forgot-password flow yet for a second
 * purpose to share the table with.
 */
export class PlatformStaffInvitations1758000000000 implements MigrationInterface {
  name = 'PlatformStaffInvitations1758000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "platform_user" ALTER COLUMN "password_hash" DROP NOT NULL`);
    await q.query(`ALTER TABLE "platform_user" ADD COLUMN "invited_by" text`);
    await q.query(`ALTER TABLE "platform_user" ADD COLUMN "invited_at" timestamptz`);
    await q.query(`ALTER TABLE "platform_user" ADD COLUMN "activated_at" timestamptz`);

    await q.query(`ALTER TABLE "platform_user" DROP CONSTRAINT "ck_platform_user_status"`);
    await q.query(`
      ALTER TABLE "platform_user" ADD CONSTRAINT "ck_platform_user_status"
        CHECK ("status" IN ('invited', 'active', 'suspended'))`);

    await q.query(`
      CREATE TABLE "platform_invitation" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "platform_user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_platform_invitation_token" ON "platform_invitation" ("token_hash")`);
    await q.query(`
      CREATE INDEX "ix_platform_invitation_user" ON "platform_invitation" ("platform_user_id", "consumed_at")`);

    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_invitation" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "platform_invitation"`);

    await q.query(`ALTER TABLE "platform_user" DROP CONSTRAINT IF EXISTS "ck_platform_user_status"`);
    await q.query(`
      ALTER TABLE "platform_user" ADD CONSTRAINT "ck_platform_user_status"
        CHECK ("status" IN ('active', 'suspended'))`);

    await q.query(`ALTER TABLE "platform_user" DROP COLUMN IF EXISTS "activated_at"`);
    await q.query(`ALTER TABLE "platform_user" DROP COLUMN IF EXISTS "invited_at"`);
    await q.query(`ALTER TABLE "platform_user" DROP COLUMN IF EXISTS "invited_by"`);
    await q.query(`ALTER TABLE "platform_user" ALTER COLUMN "password_hash" SET NOT NULL`);
  }
}
