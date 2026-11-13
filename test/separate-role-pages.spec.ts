import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SeparateRolePages1765100000000 } from '../src/database/migrations/1765100000000-SeparateRolePages';
import { RoleService } from '../src/identity/services/role.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SeparateRolePages1765100000000';
const ADMIN_TABS = ['admin-plant', 'admin-devices', 'admin-equipment', 'admin-model', 'admin-service-roster', 'admin-fuel-forecast-accuracy'];
const ceo: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['ceo-manager'], isPlatformRole: false };

/**
 * The geofence map and each Administration tab are granted on their own (13 Nov 2026).
 * Until now they came with "dashboard" and "admin"; a role keeps what it could open the
 * day before, and from then on the account's owner decides.
 */
describeDb('the map and Administration\'s tabs are granted on their own', () => {
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

  const seed = (slug: string, tabs: string[]) => owner.query(
    `INSERT INTO tenant_role (tenant_id, slug, name, allowed_tabs) VALUES ('acme', $1, $1, $2::text[])`, [slug, tabs]);
  const tabsOf = async (slug: string): Promise<string[]> =>
    (await owner.query(`SELECT allowed_tabs FROM tenant_role WHERE tenant_id = 'acme' AND slug = $1`, [slug]))[0].allowed_tabs;
  const up = async () => {
    const runner = owner.createQueryRunner();
    try { await new SeparateRolePages1765100000000().up(runner); } finally { await runner.release(); }
  };

  it('a role keeps what it could open: the map with the dashboard, every tab with Administration; nothing else is given', async () => {
    await seed('fleet', ['dashboard', 'settings']);
    await seed('office', ['admin', 'settings']);
    await seed('alerts-only', ['alerts']);
    await seed('half-done', ['admin', 'admin-model', 'dashboard', 'geofence']);
    await up();

    expect(await tabsOf('fleet')).toEqual(['dashboard', 'settings', 'geofence']);
    expect(await tabsOf('office')).toEqual(['admin', 'settings', ...ADMIN_TABS]);
    expect(await tabsOf('alerts-only')).toEqual(['alerts']);
    // Already holding some: only what is missing is appended, and nothing twice.
    expect(await tabsOf('half-done')).toEqual(['admin', 'admin-model', 'dashboard', 'geofence', ...ADMIN_TABS.filter((t) => t !== 'admin-model')]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seed('office', ['dashboard', 'admin']);
    await up();
    const once = await tabsOf('office');
    await up();
    expect(await tabsOf('office')).toEqual(once);
  });

  it('after it, an owner can take a tab away: a role with Models and not Devices saves, and keeps Administration', async () => {
    await roles.provisionDefaults('acme', 'u-master', new Date('2026-11-13T10:00:00Z'));
    const saved = await roles.update(ceo, 'operator', { allowedTabs: ['dashboard', 'admin-model'] });
    // The Administration entry comes with any of its tabs, so the sidebar shows the way in.
    expect(saved.allowedTabs).toEqual(['dashboard', 'admin-model', 'admin']);
    expect(await tabsOf('operator')).toEqual(['dashboard', 'admin-model', 'admin']);
  });

  it('the CEO / Manager\'s page list is refused, not saved to no effect; renaming it still works', async () => {
    await roles.provisionDefaults('acme', 'u-master', new Date('2026-11-13T10:00:00Z'));
    const before = await tabsOf('ceo-manager');
    await expect(roles.update(ceo, 'ceo-manager', { allowedTabs: before.filter((t) => t !== 'admin-fuel-forecast-accuracy') }))
      .rejects.toThrow(/opens every page/);
    expect(await tabsOf('ceo-manager')).toEqual(before);
    expect((await roles.update(ceo, 'ceo-manager', { name: 'Owner' })).name).toBe('Owner');
  });

  it(`${MIGRATION} down path: the new pages go, everything else stays in order`, async () => {
    await seed('office', ['dashboard', 'admin', 'settings']);
    await up();
    await undoMigrationNamed(owner, MIGRATION);
    try {
      expect(await tabsOf('office')).toEqual(['dashboard', 'admin', 'settings']);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  });
});
