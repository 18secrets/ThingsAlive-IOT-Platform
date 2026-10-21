import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `equipment-template.read` and `device-catalog.read` were added after the three
 * role templates were first seeded, so every account provisioned before this
 * migration has roles that can't see the equipment templates / sensor catalog a
 * client's own Equipment Template page needs (Master Admin's defaults, plus
 * whatever sensors are attached) — the GET routes require the read capability now
 * instead of the write one, and no existing tenant role holds it.
 *
 * Only touches rows still exactly equal to the pre-read-capability template
 * default; a role a client has already edited is left alone, same reasoning as
 * `AddPredictionsTab`.
 */
export class AddTemplateReadCapabilities1757953000000 implements MigrationInterface {
  name = 'AddTemplateReadCapabilities1757953000000';

  private readonly previousCapabilities: Record<string, string[]> = {
    'ceo-manager': [
      'user.manage', 'role.manage', 'equipment.write',
      'scenario.activate', 'scenario.author', 'alert.author', 'action.work', 'action.assign',
      'catalog.read', 'client-catalog.read', 'client-catalog.write',
      'prediction.read', 'prediction.run', 'utilization.read',
      'device.read', 'device.claim',
    ],
    'site-manager': [
      'equipment.write', 'scenario.activate', 'alert.author', 'action.work', 'action.assign',
      'catalog.read', 'client-catalog.read',
      'prediction.read', 'prediction.run', 'utilization.read',
      'device.read', 'device.claim',
    ],
    operator: [
      'action.work', 'catalog.read', 'client-catalog.read',
      'prediction.read', 'utilization.read', 'device.read',
    ],
  };

  public async up(q: QueryRunner): Promise<void> {
    for (const [slug, caps] of Object.entries(this.previousCapabilities)) {
      await q.query(
        `UPDATE "tenant_role" SET "capabilities" = "capabilities" || '{equipment-template.read,device-catalog.read}'::text[]
           WHERE "template_slug" = $1 AND "capabilities" = $2::text[]`,
        [slug, caps],
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible in a meaningful way — see BackfillTenantRoleAllowedTabs's down().
  }
}
