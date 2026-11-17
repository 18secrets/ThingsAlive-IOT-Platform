import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { RoleService } from '../src/identity/services/role.service';
import { UserService } from '../src/identity/services/user.service';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const NOW = new Date('2026-11-13T10:00:00Z');
const ADMIN_TABS = ['dashboard', 'things-care', 'things-shield', 'alerts', 'predictions', 'scenarios', 'work-orders', 'admin', 'settings'];
const MIGRATION = 'WorkOrderStartAssigned1765000000000';

/**
 * The testing sheet of 13 Nov, its server half. Each refusal is the forbidden thing
 * attempted, not a rule read back.
 *
 * - TC_193–196: an "Admin" — a custom role holding user.manage and role.manage — runs
 *   people below itself. Only the account's CEO / Manager changes roles or grants a role
 *   that itself manages people; nobody changes their own role.
 * - TC_191: a job is started by somebody, never by nobody — in the service and the database.
 * - TC_192: a job is edited only before it is started.
 */
describeDb('who may hand out power, and when a job may be started or edited', () => {
  let owner: DataSource;
  let ds: DataSource;
  let users: UserService;
  let roles: RoleService;
  let work: WorkOrderService;
  let ceo: RequestScope;
  let admin: RequestScope;
  let operatorId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    users = new UserService(ds);
    roles = new RoleService(ds);
    work = new WorkOrderService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "work_order_event", "work_order", "user_equipment_access", "user_plant_access",
      "user_invitation", "app_user", "tenant_role" RESTART IDENTITY CASCADE`);
    await roles.provisionDefaults('acme', 'u-master', NOW);
    const caps = async (slug: string) => (await owner.query(
      `SELECT capabilities FROM tenant_role WHERE tenant_id = 'acme' AND slug = $1`, [slug]))[0].capabilities as string[];
    const seedUser = async (email: string, roleSlug: string) => (await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', $1, $1, $2, 'active') RETURNING id`,
      [email, roleSlug]))[0].id as string;

    const ceoId = await seedUser('ceo@acme.test', 'ceo-manager');
    ceo = { tenantId: 'acme', userId: ceoId, roles: ['ceo-manager'], isPlatformRole: false, capabilities: await caps('ceo-manager') };
    await roles.create(ceo, {
      slug: 'admin', name: 'Admin', capabilities: ['user.manage', 'role.manage', 'action.work', 'action.assign'],
      scopeShape: 'tenant', allowedTabs: ADMIN_TABS,
    });
    const adminId = await seedUser('admin@acme.test', 'admin');
    admin = { tenantId: 'acme', userId: adminId, roles: ['admin'], isPlatformRole: false, capabilities: await caps('admin') };
    operatorId = await seedUser('op@acme.test', 'operator');
  });

  // ------------------------------------------------------------------ TC_194
  it('an Admin cannot change anyone\'s role, its own included; the CEO / Manager can change others\'', async () => {
    await expect(users.setRole(admin, operatorId, 'site-manager')).rejects.toThrow(/Only a CEO \/ Manager/);
    await expect(users.setRole(admin, admin.userId, 'ceo-manager')).rejects.toThrow(/your own role/);
    await expect(users.setRole(ceo, ceo.userId, 'operator')).rejects.toThrow(/your own role/);
    expect((await users.setRole(ceo, operatorId, 'site-manager')).roleSlug).toBe('site-manager');
  });

  // ------------------------------------------------------------------ TC_195, TC_196
  it('an Admin invites people below itself, never a CEO / Manager or another Admin', async () => {
    await expect(users.invite(admin, { email: 'new-ceo@acme.test', fullName: 'New CEO', roleSlug: 'ceo-manager' }, NOW))
      .rejects.toThrow(/Only a CEO \/ Manager can give someone the CEO \/ Manager role/i);
    await expect(users.invite(admin, { email: 'new-admin@acme.test', fullName: 'New Admin', roleSlug: 'admin' }, NOW))
      .rejects.toThrow(/Only a CEO \/ Manager can give someone the Admin role/);
    expect((await users.invite(admin, { email: 'fitter@acme.test', fullName: 'Fitter', roleSlug: 'operator' }, NOW)).roleSlug)
      .toBe('operator');
    expect((await users.invite(ceo, { email: 'admin2@acme.test', fullName: 'Admin Two', roleSlug: 'admin' }, NOW)).roleSlug)
      .toBe('admin');
  });

  // ------------------------------------------------------------------ TC_193 (the role half)
  it('an Admin cannot make or widen a role that manages people', async () => {
    await expect(roles.create(admin, { slug: 'admin-2', name: 'Admin 2', capabilities: ['user.manage'], scopeShape: 'tenant' }))
      .rejects.toThrow(/Only a CEO \/ Manager/);
    await expect(roles.update(admin, 'admin', { allowedTabs: [...ADMIN_TABS, 'cost-administration'] }))
      .rejects.toThrow(/Only a CEO \/ Manager/);
    await expect(roles.update(admin, 'operator', { capabilities: ['action.work', 'role.manage'] }))
      .rejects.toThrow(/Only a CEO \/ Manager/);
    expect((await roles.create(admin, { slug: 'fitter', name: 'Fitter', capabilities: ['action.work'], scopeShape: 'tenant' })).slug)
      .toBe('fitter');
  });

  // ------------------------------------------------------------------ TC_191, TC_192
  const seedJob = async () => (await owner.query(
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, raised_by)
     VALUES ('acme', 'WO-T1', 'ss', 'M-1', 'Check the radiator', 'created', 'normal', 'u') RETURNING id`))[0].id as string;

  it('a job cannot be started until somebody is assigned to it — by the service, and by the database', async () => {
    const id = await seedJob();
    await expect(work.act(ceo, id, 'start', null, NOW)).rejects.toThrow(/Assign WO-T1 to someone before starting it/);
    await expect(owner.query(`UPDATE work_order SET status = 'in-progress' WHERE id = $1`, [id]))
      .rejects.toThrow(/ck_work_order_in_progress_assigned/);

    await owner.query(`UPDATE work_order SET assigned_to_user_id = $1 WHERE id = $2`, [operatorId, id]);
    expect((await work.act(ceo, id, 'start', null, NOW)).status).toBe('in-progress');
    await expect(work.assign(ceo, id, null)).rejects.toThrow(/in progress/);
  });

  it('a job can be edited before it is started, and not after', async () => {
    const id = await seedJob();
    expect((await work.update(ceo, id, { title: 'Check and clean the radiator' })).title).toBe('Check and clean the radiator');
    await owner.query(`UPDATE work_order SET assigned_to_user_id = $1 WHERE id = $2`, [operatorId, id]);
    await work.act(ceo, id, 'start', null, NOW);
    await expect(work.update(ceo, id, { title: 'Something else' })).rejects.toThrow(/edited only before it is started/);
  });

  it(`${MIGRATION} comes off and goes back on`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT 1 FROM pg_constraint WHERE conname = 'ck_work_order_in_progress_assigned'`)).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT 1 FROM pg_constraint WHERE conname = 'ck_work_order_in_progress_assigned'`)).toHaveLength(1);
  });
});
