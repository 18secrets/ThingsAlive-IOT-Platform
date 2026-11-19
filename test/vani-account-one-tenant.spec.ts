import { DataSource, EntityManager } from 'typeorm';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * One tenant per Vani account (`1765700000000-VaniAccountOneTenant.ts`).
 *
 * Vani's callbacks and inbound questions name an account, never a tenant, so a Vani
 * account shared by two tenants is one customer hearing another's alerts. Each case
 * attempts exactly that through `ta_app` inside the second tenant — the path a running
 * service would take — and expects the database to refuse it.
 */
describeDb('vani: one tenant per Vani account', () => {
  let owner: DataSource;
  let app: DataSource;

  const asTenant = <R>(tenant: string, fn: (m: EntityManager) => Promise<R>) =>
    app.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn(m);
    });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    for (const t of ['usa-test', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1)`, [t]);
    }
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM vani_account_link`);
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
  });

  it('refuses a second tenant linking an account another tenant holds', async () => {
    await expect(asTenant('globex', (m) => m.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('globex', 'usa-test-01')`,
    ))).rejects.toThrow(/uq_vani_account_link_account/);
  });

  it('refuses re-pointing a tenant\'s own link at an account another tenant holds', async () => {
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('globex', 'globex-01')`);
    await expect(asTenant('globex', (m) => m.query(
      `UPDATE vani_account_link SET vani_account_id = 'usa-test-01' WHERE tenant_id = 'globex'`,
    ))).rejects.toThrow(/uq_vani_account_link_account/);
  });

  it('keeps the account held while the link is disabled', async () => {
    // Calls switched off for a customer is not their account handed to someone else.
    await owner.query(`UPDATE vani_account_link SET enabled = false WHERE tenant_id = 'usa-test'`);
    await expect(asTenant('globex', (m) => m.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('globex', 'usa-test-01')`,
    ))).rejects.toThrow(/uq_vani_account_link_account/);
  });

  it('lets another tenant take the account once the first link is removed', async () => {
    // The rule is "one at a time", not "first claim forever": a mistaken link is fixed
    // by deleting it, and the right tenant can then be linked.
    await owner.query(`DELETE FROM vani_account_link WHERE tenant_id = 'usa-test'`);
    await asTenant('globex', (m) => m.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('globex', 'usa-test-01')`,
    ));
    const [row] = await owner.query(`SELECT tenant_id FROM vani_account_link WHERE vani_account_id = 'usa-test-01'`);
    expect(row.tenant_id).toBe('globex');
  });

  it('refuses to run over an account already shared, naming it, and undoes cleanly', async () => {
    await undoMigrationNamed(owner, 'VaniAccountOneTenant1765700000000');
    const [plain] = await owner.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_vani_account_link_account'`);
    expect(plain.indexdef).not.toMatch(/UNIQUE/);

    // The state the migration exists to prevent, reachable only while it is undone.
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('globex', 'usa-test-01')`);
    await expect(owner.runMigrations({ transaction: 'all' }))
      .rejects.toThrow(/usa-test-01 \(globex, usa-test\)/);

    await owner.query(`DELETE FROM vani_account_link WHERE tenant_id = 'globex'`);
    await owner.runMigrations({ transaction: 'all' });
    const [unique] = await owner.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_vani_account_link_account'`);
    expect(unique.indexdef).toMatch(/UNIQUE/);
  });
});
