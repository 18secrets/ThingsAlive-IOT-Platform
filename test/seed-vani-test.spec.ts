import { DataSource } from 'typeorm';
import { seedCatalog } from '../src/database/seeds/seed-catalog';
import {
  LIBRARY_CLASS, requireLocal, seedVaniTest, VANI_ACCOUNT_ID, VANI_MACHINE_ID, VANI_TEST_MACHINE,
  VANI_TEST_TENANT, VIBRATION_LIMIT_MM_S, vaniTestReadings,
} from '../src/database/seeds/seed-vani-test';
import { createTestDataSource, describeDb } from './db';

/**
 * The Vani test client seed (plan Phase 4). It is a script somebody runs by hand, so
 * what is worth proving is that it builds the client the guide describes, raises the
 * alert through the engine, queues exactly one call, refuses where it should, and does
 * nothing the second time.
 */
describe('seed:vani-test refusals', () => {
  it('runs against a local database only', () => {
    expect(() => requireLocal({ DB_HOST: 'localhost' })).not.toThrow();
    expect(() => requireLocal({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/ta2' })).not.toThrow();
    expect(() => requireLocal({ DB_HOST: 'postgres.railway.internal' })).toThrow(/local database only/);
    expect(() => requireLocal({ DATABASE_URL: 'postgres://u:p@roundhouse.proxy.rlwy.net:5432/railway' }))
      .toThrow(/local database only/);
  });

  it('tells a story that breaches on the last readings, however it is run', () => {
    const vibration = vaniTestReadings(new Date('2026-11-04T03:17:00Z')).find((r) => r.signal === 'vibration_velocity')!;
    expect(vibration.values).toHaveLength(72 * 6 + 1);
    expect(vibration.values[0]).toBeLessThan(2.8);
    // The rule needs 6 of the last 10 past the limit; the whole last ten are.
    expect(vibration.values.slice(-10).every((v) => v > VIBRATION_LIMIT_MM_S)).toBe(true);
  });
});

describeDb('seed:vani-test', () => {
  let ds: DataSource;
  const env = { SEED_VANI_TEST_ENABLED: 'true', DB_HOST: 'localhost' };
  const now = new Date('2026-11-04T03:17:00Z');

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); });

  it('refuses without the flag, and before the library class is published', async () => {
    await expect(seedVaniTest(ds, { now, env: { DB_HOST: 'localhost' } })).rejects.toThrow(/SEED_VANI_TEST_ENABLED/);
    await expect(seedVaniTest(ds, { now, env })).rejects.toThrow(/not published/);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM tenant WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(n).toBe(0);
  });

  it('builds the client, raises the alert through the engine, and queues one call', async () => {
    await ds.transaction((m) => seedCatalog(m, true));
    const result = await seedVaniTest(ds, { now, env });
    expect(result).toMatchObject({ created: true, tenantId: VANI_TEST_TENANT, alertsRaised: 1, callsQueued: 1 });

    const [machine] = await ds.query(
      `SELECT e.name, e.equipment_class_slug, p.name AS site FROM equipment_profile e JOIN plant p ON p.id = e.plant_id
        WHERE e.tenant_id = $1 AND e.external_id = $2`, [VANI_TEST_TENANT, VANI_TEST_MACHINE]);
    expect(machine).toEqual({ name: 'Diesel Generator DG-01', equipment_class_slug: LIBRARY_CLASS, site: 'Grapevine, TX' });

    const [grant] = await ds.query(
      `SELECT 1 FROM client_catalog_entitlement WHERE tenant_id = $1 AND equipment_class_slug = $2`,
      [VANI_TEST_TENANT, LIBRARY_CLASS]);
    expect(grant).toBeDefined();

    const [alert] = await ds.query(`SELECT id, severity, rule_name, state FROM alert_event WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(alert).toMatchObject({ severity: 'critical', state: 'open' });
    expect(alert.rule_name).toMatch(/^Main bearing vibration on Diesel Generator DG-01 is rising/);

    const [call] = await ds.query(`SELECT * FROM vani_call WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(call).toMatchObject({ alert_event_id: alert.id, state: 'pending', severity: 'critical' });
    expect(call.request).toMatchObject({
      event_id: alert.id,
      account_id: VANI_ACCOUNT_ID,
      customer_phone: '+12012031340',
      machine: { machine_id: VANI_MACHINE_ID, name: 'Diesel Generator DG-01' },
      trigger: { kind: 'alert', severity: 'critical' },
    });
    // What Vani says: the evidence in words, not the engine's screen summary.
    expect(call.request.context.summary).toBe(
      'Bearing vibration on Diesel Generator DG-01 has been above 4.5 millimeters per second '
      + 'on all of the last 10 readings, reaching 5.25 millimeters per second.',
    );

    const [{ readings }] = await ds.query(
      `SELECT count(*)::int AS readings FROM telemetry_reading WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(readings).toBe(3 * (72 * 6 + 1));
  });

  it('does nothing the second time', async () => {
    const again = await seedVaniTest(ds, { now, env });
    expect(again).toMatchObject({ created: false, callsQueued: 0 });
    const [{ calls }] = await ds.query(`SELECT count(*)::int AS calls FROM vani_call WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(calls).toBe(1);
  });
});
