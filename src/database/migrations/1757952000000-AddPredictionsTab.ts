import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The "Live Predictions" page was added after `BackfillTenantRoleAllowedTabs` ran, so
 * every account provisioned before this migration has a CEO/Manager and Site manager
 * role missing it — same gap that migration closed for the original page set.
 *
 * Only touches rows still exactly equal to the pre-predictions template default; a
 * role a client has already edited (added/removed a page) is left alone.
 */
export class AddPredictionsTab1757952000000 implements MigrationInterface {
  name = 'AddPredictionsTab1757952000000';

  private readonly previousDefault: Record<string, string[]> = {
    'ceo-manager': ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
    'site-manager': ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
  };

  public async up(q: QueryRunner): Promise<void> {
    for (const [slug, tabs] of Object.entries(this.previousDefault)) {
      await q.query(
        `UPDATE "tenant_role" SET "allowed_tabs" = "allowed_tabs" || '{predictions}'::text[]
           WHERE "template_slug" = $1 AND "allowed_tabs" = $2::text[]`,
        [slug, tabs],
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible in a meaningful way — see BackfillTenantRoleAllowedTabs's down().
  }
}
