import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Who a job can name (dashboard testing, issue 9).
 *
 * The console's assignee picker and history read names from here, so what matters is
 * what it leaves out: people in another account, people who cannot sign in (invited,
 * suspended), and anything about a person beyond their id and name.
 */
describeDb('work order people', () => {
  let ds: DataSource;
  let owner: DataSource;
  let orders: WorkOrderService;

  const siteManager: RequestScope = {
    tenantId: 'acme', userId: 'u-site', roles: ['site-manager'], isPlatformRole: false,
    capabilities: ['action.work', 'action.assign'],
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    orders = new WorkOrderService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM app_user`);
    const person = (tenant: string, email: string, name: string, status: string) => owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, password_hash)
        VALUES ($1, $2, $3, 'operator', $4, $5)`,
      [tenant, email, name, status, status === 'invited' ? null : 'irrelevant-hash'],
    );
    await person('acme', 'ravi@acme.test', 'Ravi Kumar', 'active');
    await person('acme', 'asha@acme.test', 'Asha Rao', 'active');
    await person('acme', 'new@acme.test', 'Not Yet Joined', 'invited');
    await person('acme', 'gone@acme.test', 'Has Left', 'suspended');
    await person('globex', 'someone@globex.test', 'Other Account', 'active');
  });

  it("lists this account's active people by name, and nothing else about them", async () => {
    const people = await orders.people(siteManager);
    expect(people.map((p) => p.fullName)).toEqual(['Asha Rao', 'Ravi Kumar']);
    for (const p of people) expect(Object.keys(p).sort()).toEqual(['fullName', 'id']);
  });

  it('shows another account only its own people', async () => {
    const people = await orders.people({ ...siteManager, tenantId: 'globex' });
    expect(people.map((p) => p.fullName)).toEqual(['Other Account']);
  });
});
