import { DataSource } from 'typeorm';
import { CADENCE_SECONDS, DEMO_TENANT, running, seedDemo, topUpDemo } from '../src/database/seeds/seed-demo';
import { createTestDataSource, describeDb } from './db';

/** A Tuesday, 12:30 in Pune — the seed's own test clock. */
const SEEDED = new Date('2026-10-06T07:00:00.000Z');
const LATER = new Date(SEEDED.getTime() + 3 * 3_600_000);
/** Where each machine's last reading sits: a day before, so the gap spans a night. */
const STOPPED = new Date(SEEDED.getTime() - 86_400_000);
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const STEP = CADENCE_SECONDS * 1000;
const SS = 'ta-2.0';

/**
 * The demo stream burns each onboarded machine's fuel around its class's norm.
 *
 * It burned 12.4–13.9 L/h on every machine, the demo excavator's figure. Real classes
 * span 2.6 L/h (a truck-mounted crane) to nearly 80 (a pick-and-carry crane), so a flat
 * rate made a low-burn machine read as wasting fuel on every shift, and a fuel-burn
 * scenario flagged it for ever. The norm is the class's nominal_fuel_per_hour at the
 * version the machine is on — the figure OEE judges fuel against.
 */
describeDb('seed:demo top-up burns fuel at the class norm', () => {
  let owner: DataSource;

  const machine = async (externalId: string, imei: string, cls: string | null) => {
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by,
         equipment_class_slug, class_version)
       VALUES ($1, $2, $3, 'standard', '{}'::jsonb, 'fixture', $4, $5)`,
      [DEMO_TENANT, SS, externalId, cls, cls ? 1 : null]);
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, canonical_unit, valid_from, is_primary, status, expected_period_seconds)
       VALUES ($1, $2, $3, 'fuel_consumption', 'fuel_consumption', '', 'physical', $4, 'L/h', '2026-01-01T00:00:00Z', true, 'active', 600)`,
      [DEMO_TENANT, SS, externalId, imei]);
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ($1, $2, 'fuel_consumption', 3, 'L/h', $3, $3, 'simulated')`,
      [DEMO_TENANT, imei, STOPPED]);
  };
  const streamed = async (imei: string) => (await owner.query(
    `SELECT source_timestamp AS at, value FROM telemetry_reading
      WHERE tenant_id = $1 AND imei = $2 AND signal = 'fuel_consumption' AND source_timestamp > $3
      ORDER BY source_timestamp`,
    [DEMO_TENANT, imei, STOPPED],
  )).map((r: { at: Date; value: string }) => ({ at: new Date(r.at).getTime(), value: Number(r.value) }));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await seedDemo(owner, { now: SEEDED, env: ENABLED });
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, status, name, nominal_fuel_per_hour, nominal_fuel_unit) VALUES
         ('truck-crane', 1, 'published', 'Truck crane', 2.6, 'L/h'),
         ('no-norm', 1, 'published', 'No norm', NULL, NULL)`);
    await machine('LOW-1', 'IMEI-L1', 'truck-crane');
    await machine('NONORM-1', 'IMEI-N1', 'no-norm');
    await machine('NOCLASS-1', 'IMEI-C1', null);
    await topUpDemo(owner, { now: LATER, env: ENABLED });
  }, 180_000);

  afterAll(async () => { await owner?.destroy(); });

  const runningOnly = (rows: { at: number; value: number }[]) => rows.filter((r) => running(r.at));

  it('burns 83–93% of its class norm while running, and nothing while stopped', async () => {
    const rows = await streamed('IMEI-L1');
    expect(rows).toHaveLength((LATER.getTime() - STOPPED.getTime()) / STEP);
    const on = runningOnly(rows);
    expect(on.length).toBeGreaterThan(0);
    for (const r of on) {
      expect(r.value).toBeGreaterThanOrEqual(2.6 * 0.83);
      expect(r.value).toBeLessThanOrEqual(2.6 * 0.93);
    }
    for (const r of rows.filter((x) => !running(x.at))) expect(r.value).toBe(0);
  });

  it('keeps the demo rate for a machine whose class states no norm, or that has no class', async () => {
    for (const imei of ['IMEI-N1', 'IMEI-C1']) {
      const on = runningOnly(await streamed(imei));
      expect(on.length).toBeGreaterThan(0);
      for (const r of on) {
        expect(r.value).toBeGreaterThanOrEqual(12.4);
        expect(r.value).toBeLessThan(13.9);
      }
    }
  });
});
