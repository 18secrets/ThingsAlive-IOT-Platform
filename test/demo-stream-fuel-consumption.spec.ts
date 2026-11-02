import { DataSource } from 'typeorm';
import { CADENCE_SECONDS, DEMO_MACHINES, DEMO_TENANT, imeiOf, running, seedDemo, topUpDemo } from '../src/database/seeds/seed-demo';
import { createTestDataSource, describeDb } from './db';

/** A Tuesday, 12:30 in Pune — the seed's own test clock. */
const SEEDED = new Date('2026-10-06T07:00:00.000Z');
const LATER = new Date(SEEDED.getTime() + 3 * 3_600_000);
/** Where the other stream stopped: a day before the seed clock. */
const STOPPED = new Date(SEEDED.getTime() - 86_400_000);
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;
const STEP = CADENCE_SECONDS * 1000;
const imei = (externalId: string) => imeiOf(DEMO_MACHINES.find((m) => m.externalId === externalId)!);

/**
 * On dev, fuel_consumption arrived from a laptop's cron stream, and when that stopped on
 * 23 Oct every demo machine's OEE read "readings are stale" with the rest of its signals
 * fresh. The top-up now carries on a fuel rate a machine already reports, from its own
 * last reading; a machine that never reported one is left without.
 */
describeDb('seed:demo top-up continues fuel_consumption', () => {
  let owner: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await seedDemo(owner, { now: SEEDED, env: ENABLED });
    // The other stream's last fuel rate on EX-01, as dev had it.
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ($1, $2, 'fuel_consumption', 12.9, 'L/h', $3, $3, 'simulated')`,
      [DEMO_TENANT, imei('EX-01'), STOPPED],
    );
  }, 180_000);

  afterAll(async () => { await owner?.destroy(); });

  const fuel = async (externalId: string): Promise<{ at: Date; value: number }[]> => (await owner.query(
    `SELECT source_timestamp AS at, value FROM telemetry_reading
      WHERE tenant_id = $1 AND imei = $2 AND signal = 'fuel_consumption' ORDER BY source_timestamp`,
    [DEMO_TENANT, imei(externalId)],
  )).map((r: { at: Date; value: string }) => ({ at: new Date(r.at), value: Number(r.value) }));

  it('two top-ups fired together both settle, and the gap from its last fuel reading to now is filled once', async () => {
    const results = await Promise.allSettled([
      topUpDemo(owner, { now: LATER, env: ENABLED }),
      topUpDemo(owner, { now: LATER, env: ENABLED }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await fuel('EX-01');
    expect(rows).toHaveLength((LATER.getTime() - STOPPED.getTime()) / STEP + 1);
    rows.forEach((r, i) => expect(r.at.getTime()).toBe(STOPPED.getTime() + i * STEP));
  });

  it('a rate while the engine runs, zero while it is stopped', async () => {
    for (const r of (await fuel('EX-01')).slice(1)) {
      if (running(r.at.getTime())) {
        expect(r.value).toBeGreaterThanOrEqual(12.4);
        expect(r.value).toBeLessThan(13.9);
      } else {
        expect(r.value).toBe(0);
      }
    }
  });

  it('a machine that never reported a fuel rate is not given one', async () => {
    expect(await fuel('EX-02')).toEqual([]);
  });
});
