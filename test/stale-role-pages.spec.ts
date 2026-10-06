import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { StripRetiredRolePages1758800000000 } from '../src/database/migrations/1758800000000-StripRetiredRolePages';
import { TENANT_ASSIGNABLE_PAGES } from '../src/identity/pages';
import { RoleService } from '../src/identity/services/role.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'StripRetiredRolePages1758800000000';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const admin = (tenantId: string): RequestScope => ({
  tenantId, userId: `u-${tenantId}`, roles: ['ceo-manager'], isPlatformRole: false,
});

/**
 * Stored role pages stay inside the page vocabulary (task QFIX-ROLES).
 *
 * `alert-agent` was backfilled into every account's template roles and then retired
 * from `TENANT_ASSIGNABLE_PAGES`, with nothing cleaning what was stored — so editing
 * any of those roles failed with "Unknown page: alert-agent", hidden only by the
 * console sanitising before it saved. These tests put that data back, as it was, and
 * show the migration removes it; the last one keeps it from happening again.
 */
describeDb('stored role pages and the page vocabulary', () => {
  let owner: DataSource;
  let ds: DataSource;
  let roles: RoleService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    roles = new RoleService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => { await owner.query(`DELETE FROM "tenant_role"`); });

  const tabsOf = async (tenantId: string, slug: string): Promise<string[]> =>
    (await owner.query(`SELECT allowed_tabs FROM tenant_role WHERE tenant_id = $1 AND slug = $2`, [tenantId, slug]))[0].allowed_tabs;

  /** The state the backfill left behind: template roles with `alert-agent` among valid pages. */
  const seedStale = async (tenantId: string) => {
    await roles.provisionDefaults(tenantId, 'u-master', NOW);
    await owner.query(
      `UPDATE tenant_role SET allowed_tabs = $2::text[] WHERE tenant_id = $1 AND slug IN ('ceo-manager', 'site-manager')`,
      [tenantId, ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings']],
    );
    await owner.query(
      `UPDATE tenant_role SET allowed_tabs = $2::text[] WHERE tenant_id = $1 AND slug = 'operator'`,
      [tenantId, ['dashboard', 'alert-agent', 'settings']],
    );
  };

  it('seeded before it runs: alert-agent is stripped in both tenants, the valid pages beside it survive in order', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      await seedStale('acme');
      await seedStale('globex');
      // A custom role that never held a retired page — the migration must not touch it.
      await owner.query(
        `INSERT INTO tenant_role (tenant_id, slug, name, allowed_tabs) VALUES ('acme', 'clean', 'Clean', $1::text[])`,
        [['alerts', 'dashboard']],
      );
      const before = await owner.query(`SELECT updated_at FROM tenant_role WHERE slug = 'clean'`);

      await owner.runMigrations({ transaction: 'all' });

      for (const tenant of ['acme', 'globex']) {
        expect(await tabsOf(tenant, 'ceo-manager')).toEqual(['dashboard', 'ai-onboarding', 'admin', 'settings']);
        expect(await tabsOf(tenant, 'site-manager')).toEqual(['dashboard', 'ai-onboarding', 'admin', 'settings']);
        expect(await tabsOf(tenant, 'operator')).toEqual(['dashboard', 'settings']);
      }
      expect(await tabsOf('acme', 'clean')).toEqual(['alerts', 'dashboard']);
      expect(await owner.query(`SELECT updated_at FROM tenant_role WHERE slug = 'clean'`)).toEqual(before);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seedStale('acme');
    const runner = owner.createQueryRunner();
    try {
      await new StripRetiredRolePages1758800000000().up(runner);
      const once = await owner.query(`SELECT slug, allowed_tabs FROM tenant_role ORDER BY slug`);
      const updated = await runner.query(
        `SELECT count(*)::int AS n FROM tenant_role WHERE NOT (allowed_tabs <@ $1::text[])`, [[...TENANT_ASSIGNABLE_PAGES]],
      );
      await new StripRetiredRolePages1758800000000().up(runner);
      expect(await owner.query(`SELECT slug, allowed_tabs FROM tenant_role ORDER BY slug`)).toEqual(once);
      expect(updated).toEqual([{ n: 0 }]);
    } finally {
      await runner.release();
    }
  });

  it('the defect, end to end: a stale role refuses to save; after the migration the same edit succeeds', async () => {
    await seedStale('acme');
    const stored = await tabsOf('acme', 'operator');
    // Any caller that sends the role's pages back as stored — everything but the
    // console, which strips them first.
    await expect(roles.update(admin('acme'), 'operator', { allowedTabs: stored }))
      .rejects.toThrow(/Unknown page: alert-agent/);

    const runner = owner.createQueryRunner();
    try { await new StripRetiredRolePages1758800000000().up(runner); } finally { await runner.release(); }

    const saved = await roles.update(admin('acme'), 'operator', { allowedTabs: await tabsOf('acme', 'operator'), name: 'Operator (edited)' });
    expect(saved).toMatchObject({ name: 'Operator (edited)', allowedTabs: ['dashboard', 'settings'] });
    // The validator stayed strict: an unknown page is still refused, not dropped.
    await expect(roles.update(admin('acme'), 'operator', { allowedTabs: ['dashboard', 'alert-agent'] }))
      .rejects.toThrow(/Unknown page: alert-agent/);
  });

  it(`down path (${MIGRATION}): does not restore the retired page`, async () => {
    await seedStale('acme');
    const runner = owner.createQueryRunner();
    try { await new StripRetiredRolePages1758800000000().up(runner); } finally { await runner.release(); }
    await undoMigrationNamed(owner, MIGRATION);
    try {
      expect(await tabsOf('acme', 'operator')).toEqual(['dashboard', 'settings']);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  });

  it('every stored page is in the vocabulary — the next retired page fails the build, not a customer\'s save', async () => {
    // Known rows, written the way accounts actually get them: the templates, plus one
    // role edited through the service. If a page leaves TENANT_ASSIGNABLE_PAGES while a
    // template still grants it, or stored data keeps one, this is where it shows.
    await roles.provisionDefaults('acme', 'u-master', NOW);
    await roles.provisionDefaults('globex', 'u-master', NOW);
    await roles.update(admin('globex'), 'operator', { allowedTabs: ['dashboard', 'work-orders'] });

    const vocabulary = new Set<string>(TENANT_ASSIGNABLE_PAGES);
    const rows: { tenant_id: string; slug: string; allowed_tabs: string[] }[] =
      await owner.query(`SELECT tenant_id, slug, allowed_tabs FROM tenant_role ORDER BY tenant_id, slug`);
    expect(rows.length).toBe(6);
    const strays = rows.flatMap((r) => r.allowed_tabs.filter((p) => !vocabulary.has(p)).map((p) => `${r.tenant_id}/${r.slug}: ${p}`));
    expect(strays).toEqual([]);
  });
});
