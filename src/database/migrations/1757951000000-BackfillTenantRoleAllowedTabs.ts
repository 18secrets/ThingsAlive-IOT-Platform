import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `allowed_tabs` was added with an empty-array default (previous migration), which
 * is correct for a brand-new custom role but wrong for the three template copies
 * every existing account already has — without this, an account provisioned before
 * this feature existed would have its CEO/Manager role granting zero pages, the
 * moment the frontend starts reading `allowedTabs` for real instead of hardcoding
 * "show everything".
 *
 * Backfills only rows that are still an unmodified copy of a known template
 * (`template_slug` set, `allowed_tabs` still empty) — a role a client has already
 * edited is edited, and this does not overwrite it.
 */
export class BackfillTenantRoleAllowedTabs1757951000000 implements MigrationInterface {
  name = 'BackfillTenantRoleAllowedTabs1757951000000';

  private readonly pages: Record<string, string[]> = {
    'ceo-manager': ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
    'site-manager': ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
    operator: ['dashboard', 'alert-agent', 'settings'],
  };

  public async up(q: QueryRunner): Promise<void> {
    for (const [slug, tabs] of Object.entries(this.pages)) {
      await q.query(
        `UPDATE "tenant_role" SET "allowed_tabs" = $1::text[]
           WHERE "template_slug" = $2 AND "allowed_tabs" = '{}'::text[]`,
        [tabs, slug],
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible in a meaningful way — the previous state (empty) carried no
    // information worth restoring, and re-emptying could clobber a real edit made
    // since this ran.
  }
}
