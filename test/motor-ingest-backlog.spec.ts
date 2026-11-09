import { DataSource } from 'typeorm';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { batches, simulate } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A backlog larger than one pass. A logger back after hours offline uploads them all at
 * once; the job places them in passes. Each pass used to anchor its own chunk on the
 * moment it arrived, so 23 hours of readings were stacked onto the last five (found
 * loading 24 hours through the real receiver). The anchor is now the newest reading
 * still waiting for that boot, whichever pass reaches it.
 */
describeDb('motor logger: a backlog spread over several passes', () => {
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;

  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);

  /** The receiver's insert, verbatim in shape (see motor-ingest.spec's `receive`), batched for speed. */
  const store = async (records: ReturnType<typeof simulate>, receivedAt: Date) => {
    for (const b of batches('MOTOR_001', records, 0)) {
      await owner.query(
        `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm, batch_id, received_at)
         SELECT $1, x.seq, x.ts, x.v, x.i, x.pf, x.t, x.rpm, $2, $3
           FROM jsonb_to_recordset($4::jsonb) AS x(seq bigint, ts bigint, v numeric, i numeric, pf numeric, t numeric, rpm int)`,
        [b.device_id, b.batch_id, receivedAt, JSON.stringify(b.records.map((r) => ({
          seq: r.seq, ts: r.timestamp, v: r.voltage, i: r.current, pf: r.power_factor, t: r.temperature, rpm: r.rpm,
        })))],
      );
      await owner.query(
        `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
        [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.records.length, b.boot, b.lost_total, b.dropped_total, receivedAt],
      );
    }
  };

  const span = () => owner.query(
    `SELECT extract(epoch FROM max(reading_at) - min(reading_at))::int AS s,
            count(DISTINCT reading_at)::int AS distinct_times, count(*)::int AS n,
            count(*) FILTER (WHERE reading_at IS NULL)::int AS waiting
       FROM motor_sensor_records`).then((r: { s: number; distinct_times: number; n: number; waiting: number }[]) => r[0]);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    motors = new MotorIngestService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log" CASCADE`);
  });

  it('a backlog placed in four passes spreads over the time it covers, one second per reading', async () => {
    // Twenty minutes, all arriving in the same second, placed 300 at a time.
    await store(simulate('normal', 1200, END, END - 1300), NOW);
    for (let pass = 0; pass < 4; pass++) await motors.processPending(NOW, 300);
    const s = await span();
    expect(s.waiting).toBe(0);
    expect(s.s).toBe(1199);
    expect(s.distinct_times).toBe(1200);
  });

  it('the newest reading lands at its arrival whichever pass reaches it', async () => {
    await store(simulate('normal', 600, END, END - 700), NOW);
    await motors.processPending(NOW, 100);
    // The first pass placed the oldest hundred, ten minutes back — not at NOW.
    const [first] = await owner.query(`SELECT max(reading_at) AS at FROM motor_sensor_records WHERE reading_at IS NOT NULL`);
    expect(NOW.getTime() - new Date(first.at).getTime()).toBeGreaterThanOrEqual(499_000);
    while ((await span()).waiting > 0) await motors.processPending(NOW, 100);
    const [last] = await owner.query(`SELECT max(reading_at) AS at FROM motor_sensor_records`);
    expect(new Date(last.at).getTime()).toBe(NOW.getTime());
  });
});
