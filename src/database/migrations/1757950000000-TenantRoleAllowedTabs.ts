import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Page access for a client's own role, separate from `capabilities` (task: role
 * page access). See `TenantRole.allowedTabs`'s own comment for why this is a
 * second column rather than reusing `capabilities`.
 */
export class TenantRoleAllowedTabs1757950000000 implements MigrationInterface {
  name = 'TenantRoleAllowedTabs1757950000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "tenant_role" ADD COLUMN "allowed_tabs" text[] NOT NULL DEFAULT '{}'::text[]`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "tenant_role" DROP COLUMN IF EXISTS "allowed_tabs"`);
  }
}
