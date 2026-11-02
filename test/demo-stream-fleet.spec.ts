import { DataSource } from 'typeorm';
import { CADENCE_SECONDS, DEMO_TENANT, seedDemo, topUpDemo } from '../src/database/seeds/seed-demo';
import { createTestDataSource, describeDb } from './db';

/** A Tuesday, 12:30 in Pune — the seed's own test clock. */
const SEEDED = new Date('2026-10-06T07:00:00.000Z');
const LATER = new Date(SEEDED.getTime() + 3 * 3_600_000);
/** Where the laptop stream stopped: a day before the seed clock. */
const STOPPED = new Date(SEEDED.getTime() - 86_400_000);
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const STEP = CADENCE_SECONDS * 1000;
const SS = 'ta-2.0';

/**
 * Dev's demo tenant has eight machines the seed did not create (EX-08..14, EXC-001, from
 * fleet onboarding). Their readings came from a laptop's cron stream and stopped with it
 * on 23 Oct, every signal on them stale. The top-up now carries on each of their bound
 * signals from its own last reading.
 */
describeDb('seed:demo top-up continues the onboarded fleet', () => {
  let owner: DataSource;

  const bind = (externalId: string, imei: string, signal: string, validTo: Date | null = null) => owner.query(
    `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
       origin, imei, canonical_unit, valid_from, valid_to, is_primary, status, expected_period_seconds)
     VALUES ($1, $2, $3, $4, $4, '', 'physical', $5, 'u', '2026-01-01T00:00:00Z', $6, true, 'active', 600)`,
    [DEMO_TENANT, SS, externalId, signal, imei, validTo]);
  const reading = (imei: string, signal: string, value: number, unit: string) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'simulated')`,
    [DEMO_TENANT, imei, signal, value, unit, STOPPED]);
  const series = async (imei: string, signal: string): Promise<{ at: number; value: number; unit: string }[]> => (await owner.query(
    `SELECT source_timestamp AS at, value, unit FROM telemetry_reading
      WHERE tenant_id = $1 AND imei = $2 AND signal = $3 ORDER BY source_timestamp`,
    [DEMO_TENANT, imei, signal],
  )).map((r: { at: Date; value: string; unit: string }) => ({ at: new Date(r.at).getTime(), value: Number(r.value), unit: r.unit }));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await seedDemo(owner, { now: SEEDED, env: ENABLED });
    for (const ext of ['FL-1', 'FL-2']) {
      await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
        VALUES ($1, $2, $3, 'standard', '{}'::jsonb, 'fixture')`, [DEMO_TENANT, SS, ext]);
    }
    // FL-1: two signals that were streaming, and one bound but never reported.
    await bind('FL-1', 'IMEI-F1', 'engine_coolant_temperature');
    await bind('FL-1', 'IMEI-F1', 'fuel_consumption');
    await bind('FL-1', 'IMEI-F1', 'engine_load');
    await reading('IMEI-F1', 'engine_coolant_temperature', 85, 'degC');
    await reading('IMEI-F1', 'fuel_consumption', 12.9, 'L/h');
    // FL-2: its binding was retired, so its logger is no longer this machine's.
    await bind('FL-2', 'IMEI-F2', 'engine_coolant_temperature', new Date(STOPPED.getTime() - 3_600_000));
    await reading('IMEI-F2', 'engine_coolant_temperature', 85, 'degC');
  }, 180_000);

  afterAll(async () => { await owner?.destroy(); });

  it('two top-ups fired together both settle, and each streamed signal\'s gap is filled once, in its own unit', async () => {
    const results = await Promise.allSettled([
      topUpDemo(owner, { now: LATER, env: ENABLED }),
      topUpDemo(owner, { now: LATER, env: ENABLED }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const expected = (LATER.getTime() - STOPPED.getTime()) / STEP + 1;
    for (const [signal, unit] of [['engine_coolant_temperature', 'degC'], ['fuel_consumption', 'L/h']]) {
      const rows = await series('IMEI-F1', signal);
      expect(rows).toHaveLength(expected);
      rows.forEach((r, i) => expect(r.at).toBe(STOPPED.getTime() + i * STEP));
      expect(new Set(rows.map((r) => r.unit))).toEqual(new Set([unit]));
    }
  });

  it('carried on as a healthy machine: coolant well under the 105 °C bound', async () => {
    const coolant = (await series('IMEI-F1', 'engine_coolant_temperature')).slice(1);
    expect(Math.max(...coolant.map((r) => r.value))).toBeLessThan(105);
  });

  it('a signal bound but never reported, and a retired binding, are not written', async () => {
    expect(await series('IMEI-F1', 'engine_load')).toEqual([]);
    expect(await series('IMEI-F2', 'engine_coolant_temperature')).toHaveLength(1);
  });

  it('run again at the same clock, it writes nothing for the fleet', async () => {
    const again = await topUpDemo(owner, { now: LATER, env: ENABLED });
    expect(again.written['FL-1']).toBe(0);
  });
});
