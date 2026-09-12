import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb } from './db';

/**
 * Every tenant-owned table is covered by the isolation policy (task P1-62).
 *
 * The list of protected tables is maintained by hand in the migrations, and the
 * failure mode when somebody forgets is the worst kind: the new table works
 * perfectly, every query against it succeeds, and it is readable by every tenant.
 * Nothing fails, nothing logs, and the first sign of trouble is a customer seeing
 * another customer's data.
 *
 * So the check is derived rather than listed. It asks the entity metadata which
 * tables carry a tenant column and asserts each one has a policy — which means a new
 * tenant-owned entity fails this test the moment it is added, and the author finds
 * out before review rather than after deploy.
 */
describeDb('row-level security coverage', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  });

  afterAll(async () => { await ds?.destroy(); });

  /**
   * Deliberately not tenant-owned, each for a stated reason. Anything else that
   * grows a tenant_id column has to be protected or explicitly listed here, and
   * adding a name to this array is a visible decision in a diff.
   */
  const EXEMPT: Record<string, string> = {
    // The subject of an access record must not be able to edit it, and the tenant
    // read is what is being recorded, not what is being protected.
    platform_access_log: 'audit evidence, written about tenants rather than owned by one',
    // Refused rows have no resolvable tenant by definition — that is why they are here.
    projection_rejection: 'holds rows whose tenant could not be resolved',
    // The mapping from an external client id to a tenant cannot itself be narrowed by
    // tenant without becoming unreadable at the moment it is needed.
    tenant_map: 'the table that decides what a tenant is',
    // Commercial grants, written by Things Alive and read through the entitlement
    // join rather than by ownership.
    client_catalog_entitlement: 'platform-owned commercial record',
    // An outbox is infrastructure: drained by a worker with no request behind it,
    // spanning tenants, carrying delivery state no customer should read. The tenant's
    // view of the same facts is scenario_activation_event, which is theirs and is
    // protected. Narrowing this by tenant would make it unreadable to the publisher
    // at exactly the moment it needs to drain it.
    domain_event: 'integration outbox, drained by a worker that has no tenant session',
  };

  it('protects every table that carries a tenant column', async () => {
    const withTenant: string[] = ds.entityMetadatas
      .filter((m) => m.columns.some((c) => c.databaseName === 'tenant_id'))
      .map((m) => m.tableName)
      .sort();

    // If this is empty the test is vacuous and would pass forever.
    expect(withTenant.length).toBeGreaterThan(4);

    const policies: { tablename: string }[] = await ds.query(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    const protectedTables = new Set(policies.map((p) => p.tablename));

    const unprotected = withTenant.filter((t) => !protectedTables.has(t) && !EXEMPT[t]);
    expect(unprotected).toEqual([]);
  });

  it('forces the policy on, so the owning role is not exempt', async () => {
    const weak: { relname: string }[] = await ds.query(
      `SELECT relname FROM pg_class
        WHERE relrowsecurity AND NOT relforcerowsecurity
          AND relnamespace = 'public'::regnamespace`,
    );
    expect(weak.map((r) => r.relname)).toEqual([]);
  });

  it('names a reason for every exemption', () => {
    // Cheap, and it stops the list becoming a place to silence this test.
    for (const [table, reason] of Object.entries(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(table).not.toBe('');
    }
  });
});
