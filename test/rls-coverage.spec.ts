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
    // The full migration chain from empty, same as every other describeDb file —
    // no extra state built here. It outgrew Jest's 5s default hook timeout as the
    // chain grew; every sibling file already carries this override, this one
    // predates most of that growth and was never given one.
  }, 30_000);

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
    // What this asserts: every unique index on a tenant-owned table either includes
    // tenant_id, or is a plain uuid primary key (which cannot collide between
    // accounts by construction), or is named above with a reason a human wrote down.
    // A unique index that fits none of those is a customer's ordinary choice —
    // a code, a name — refused because a stranger used it first, on some other
    // account entirely. That is what happened to equipment, once.
    //
    // Partitioned tables (`telemetry_reading`, `prediction`) are a fourth case, not
    // a bug: Postgres requires the partition key in every unique index on a
    // partitioned table, so their primary key is (id, <partition column>) whether
    // or not tenancy has anything to do with it. That extra column is never a
    // customer's choice — it is a timestamp the row already carries — so it
    // introduces none of the collision risk this test exists to catch. Read from
    // the catalog below rather than hardcoded by name, so the next partitioned
    // table does not need this test edited to pass.
    //
    // Two levels of "not really a new index" fall out of partitioning and need the
    // same treatment: a partition's own local primary key (e.g.
    // telemetry_reading_2026_07_pkey) is Postgres's automatic physical copy of the
    // parent's; and a partition's local copy of a named unique index (e.g.
    // telemetry_reading_2026_07_imei_signal_source_timestamp_idx, the per-partition
    // mirror of uq_telemetry_reading_dedupe) is the same thing again for a
    // non-primary-key index. Both are resolved to their root — the parent table,
    // the parent index — via pg_inherits, which Postgres itself uses to track
    // exactly this relationship.
    const rows: { table: string; index: string; cols: string; rootTable: string; rootIndex: string }[] =
      await ds.query(`
      SELECT t.relname AS table, i.relname AS index,
             array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols,
             COALESCE(root_t.relname, t.relname) AS "rootTable",
             COALESCE(root_i.relname, i.relname) AS "rootIndex"
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_inherits th ON th.inhrelid = t.oid
        LEFT JOIN pg_class root_t ON root_t.oid = th.inhparent
        LEFT JOIN pg_inherits ih ON ih.inhrelid = i.oid
        LEFT JOIN pg_class root_i ON root_i.oid = ih.inhparent
       CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE x.indisunique
         AND EXISTS (SELECT 1 FROM pg_attribute ta
                      WHERE ta.attrelid = t.oid AND ta.attname = 'tenant_id' AND ta.attnum > 0)
       GROUP BY 1, 2, 4, 5
      HAVING NOT ('tenant_id' = ANY (array_agg(a.attname)))`);

    // table -> its partition key column, for every table declared PARTITION BY.
    // partattrs is an int2vector; cast to a real array to subscript it, and the
    // cast keeps the vector's own 0-based indexing rather than Postgres arrays'
    // usual 1-based default — [0] is the first (and here, only) partition column.
    const partitionKeys: { table: string; column: string }[] = await ds.query(`
      SELECT c.relname AS table, a.attname AS column
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = (p.partattrs::int2[])[0]`);
    const partitionKeyOf = new Map(partitionKeys.map((p) => [p.table, p.column]));

    const isSurrogatePk = (r: (typeof rows)[number]) => {
      if (!r.index.endsWith('_pkey')) return false;
      if (r.cols === 'id') return true;
      const partitionColumn = partitionKeyOf.get(r.rootTable);
      return partitionColumn != null && r.cols === `id,${partitionColumn}`;
    };

    const unexplained = rows
      .filter((r) => !isSurrogatePk(r))
      .filter((r) => !GLOBAL_UNIQUE[r.index] && !GLOBAL_UNIQUE[r.rootIndex])
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
