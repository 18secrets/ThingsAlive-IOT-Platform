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

  /**
   * Unique indexes on a tenant-owned table that deliberately span every account.
   *
   * Most are the opposite of a mistake — one person has one login across the whole
   * platform, a token hash must be unique everywhere, the device pool is Things
   * Alive's. But a global uniqueness rule on a column customers choose the value of
   * is a bug that only appears on the *second* customer: their perfectly ordinary
   * code is refused because a stranger used it first, and nobody can explain why.
   *
   * That is exactly what happened to equipment. So the rule is not "always include
   * the tenant" — it is that spanning accounts is a decision with a reason next to
   * it, and a new index cannot acquire one by accident.
   */
  const GLOBAL_UNIQUE: Record<string, string> = {
    uq_app_user_email: 'one person has one login across every account, by design',
    uq_user_session_token: 'a token hash must be unique everywhere it could be presented',
    uq_user_invitation_token: 'a token hash must be unique everywhere it could be presented',
    uq_app_user_external: 'an upstream user account maps to exactly one person here',
    uq_device_inventory_imei: 'the device pool is Things Alive stock, not a customer table',
    uq_tenant_map_source: 'the table that decides which account an upstream client is',
    uq_equipment_projection_external: 'mirrors one upstream system, whose ids are its own',
    uq_device_projection_external: 'mirrors one upstream system, whose ids are its own',
    uq_sensor_map_projection_external: 'mirrors one upstream system, whose ids are its own',
    uq_telemetry_reading_dedupe: 'keyed by IMEI, which comes from the globally unique pool',
  };

  it('does not let one account\'s choice of code block another\'s', async () => {
    const rows: { table: string; index: string; cols: string }[] = await ds.query(`
      SELECT t.relname AS table, i.relname AS index,
             array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
       CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE x.indisunique
         AND EXISTS (SELECT 1 FROM pg_attribute ta
                      WHERE ta.attrelid = t.oid AND ta.attname = 'tenant_id' AND ta.attnum > 0)
       GROUP BY 1, 2
      HAVING NOT ('tenant_id' = ANY (array_agg(a.attname)))`);

    // A uuid primary key cannot collide between accounts; everything else has to say
    // why it spans them.
    const unexplained = rows
      .filter((r) => !(r.index.endsWith('_pkey') && /^id(,occurred_at)?$/.test(r.cols)))
      .filter((r) => !GLOBAL_UNIQUE[r.index])
      .map((r) => `${r.index} (${r.cols})`);
    expect(unexplained).toEqual([]);
  });

  it('names a reason for every exemption', () => {
    // Cheap, and it stops the list becoming a place to silence this test.
    for (const [table, reason] of Object.entries({ ...EXEMPT, ...GLOBAL_UNIQUE })) {
      expect(reason.length).toBeGreaterThan(20);
      expect(table).not.toBe('');
    }
  });
});
