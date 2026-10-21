import { INestApplication } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DEMO_CLASS, DEMO_SOURCE, DEMO_TENANT, seedDemo } from '../src/database/seeds/seed-demo';
import { TelemetrySegment, TelemetryWindowReader } from '../src/kpi/services/telemetry-window-reader';
import { createApp } from '../src/main';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createTestDataSource, describeDb } from './db';

const T = 'latest-reading-tenant';
const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);

/**
 * The query `latestPerSignalInSegments` issued before QPERF-COVERAGE, verbatim. It is
 * the oracle: the rewrite is only allowed to be faster, never to answer differently.
 */
const ORACLE = `
  SELECT DISTINCT ON (r."signal") r."signal", r."source_timestamp" AS latest
    FROM "telemetry_reading" r
    JOIN unnest($2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[]) AS seg(signal, imei, seg_from, seg_to)
      ON r."signal" = seg.signal AND r."imei" = seg.imei
     AND r."source_timestamp" >= seg.seg_from AND (seg.seg_to IS NULL OR r."source_timestamp" < seg.seg_to)
   WHERE r."tenant_id" = $1 AND r."source_timestamp" >= $6 AND r."source_timestamp" <= $7
   ORDER BY r."signal", r."source_timestamp" DESC`;

/**
 * The latest reading per signal within a machine's bindings (task QPERF-COVERAGE). The
 * same answer as before in every case the old query handled, from one index probe per
 * segment instead of a sort over the machine's whole history.
 */
describeDb('latest reading per signal', () => {
  let owner: DataSource;
  const reader = new TelemetryWindowReader();

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (const month of ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']) {
      await owner.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    }
  }, 60_000);

  afterAll(async () => { await owner?.destroy(); });
  beforeEach(async () => { await owner.query(`DELETE FROM telemetry_reading WHERE tenant_id = $1`, [T]); });

  /** Readings every `stepMinutes` over [from, to], for one device and signal. */
  const readings = (imei: string, signal: string, from: Date, to: Date, stepMinutes = 60) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       SELECT $1, $2, $3, 1, 'u', g, g, 'test'
         FROM generate_series($4::timestamptz, $5::timestamptz, ($6 || ' minutes')::interval) AS g`,
    [T, imei, signal, from, to, String(stepMinutes)],
  );
  const one = (imei: string, signal: string, at: Date) => readings(imei, signal, at, at);

  const both = async (segments: TelemetrySegment[], at: Date) => {
    const now = await runTenantSpanning(owner, 'test fixture', (m) => reader.latestPerSignalInSegments(m, T, segments, at));
    const oracleRows: { signal: string; latest: Date }[] = await owner.query(ORACLE, [
      T, segments.map((s) => s.signal), segments.map((s) => s.imei), segments.map((s) => s.from), segments.map((s) => s.to),
      new Date(Math.min(...segments.map((s) => s.from.getTime()))), at,
    ]);
    const asObject = (m: Map<string, Date>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toISOString()]).sort());
    return { now: asObject(now), oracle: asObject(new Map(oracleRows.map((r) => [r.signal, new Date(r.latest)]))) };
  };

  // ================================================================= the oracle
  it('one open segment across three monthly partitions: the newest reading up to at', async () => {
    await readings('I1', 'a', d('2026-08-01T00:00:00Z'), d('2026-10-05T23:00:00Z'));
    const r = await both([{ signal: 'a', imei: 'I1', from: d('2026-08-01T00:00:00Z'), to: null }], d('2026-10-06T00:00:00Z'));
    expect(r.now).toEqual({ a: '2026-10-05T23:00:00.000Z' });
    expect(r.now).toEqual(r.oracle);
  });

  it('a signal moved between devices: the closed segment ignores what its old device sent afterwards', async () => {
    // I1 was on this machine until 1 September, then went elsewhere and kept reporting.
    await readings('I1', 'b', d('2026-08-01T00:00:00Z'), d('2026-10-05T00:00:00Z'));
    // I2 took over on 1 September and went quiet on the 20th.
    await readings('I2', 'b', d('2026-09-01T00:00:00Z'), d('2026-09-20T00:00:00Z'));
    const segments = [
      { signal: 'b', imei: 'I1', from: d('2026-08-01T00:00:00Z'), to: d('2026-09-01T00:00:00Z') },
      { signal: 'b', imei: 'I2', from: d('2026-09-01T00:00:00Z'), to: null },
    ];
    const r = await both(segments, d('2026-10-06T00:00:00Z'));
    expect(r.now).toEqual({ b: '2026-09-20T00:00:00.000Z' });
    expect(r.now).toEqual(r.oracle);
  });

  it('bounds are half-open on the segment and inclusive at at; readings before the segment or after at do not count', async () => {
    await one('I1', 'c', d('2026-08-31T23:59:59Z'));    // before the segment
    await one('I1', 'c', d('2026-09-10T00:00:00Z'));    // exactly at `at`: counts
    await one('I1', 'c', d('2026-09-10T00:00:01Z'));    // after `at`
    await one('I1', 'e', d('2026-09-05T00:00:00Z'));
    await one('I1', 'e', d('2026-09-06T00:00:00Z'));    // exactly at seg_to: excluded
    const segments = [
      { signal: 'c', imei: 'I1', from: d('2026-09-01T00:00:00Z'), to: null },
      { signal: 'e', imei: 'I1', from: d('2026-09-01T00:00:00Z'), to: d('2026-09-06T00:00:00Z') },
    ];
    const r = await both(segments, d('2026-09-10T00:00:00Z'));
    expect(r.now).toEqual({ c: '2026-09-10T00:00:00.000Z', e: '2026-09-05T00:00:00.000Z' });
    expect(r.now).toEqual(r.oracle);
  });

  it('a bound signal that never reported is absent, not null — the caller reads that as no_readings', async () => {
    await readings('I1', 'a', d('2026-09-01T00:00:00Z'), d('2026-09-02T00:00:00Z'));
    const segments = [
      { signal: 'a', imei: 'I1', from: d('2026-09-01T00:00:00Z'), to: null },
      { signal: 'silent', imei: 'I1', from: d('2026-09-01T00:00:00Z'), to: null },
    ];
    const r = await both(segments, d('2026-09-10T00:00:00Z'));
    expect(Object.keys(r.now)).toEqual(['a']);
    expect(r.now).toEqual(r.oracle);
  });

  it('another tenant\'s readings on the same device and signal never count', async () => {
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
         VALUES ('someone-else', 'I1', 'a', 1, 'u', $1, $1, 'test')`,
      [d('2026-09-09T00:00:00Z')],
    );
    await one('I1', 'a', d('2026-09-02T00:00:00Z'));
    const r = await both([{ signal: 'a', imei: 'I1', from: d('2026-09-01T00:00:00Z'), to: null }], d('2026-09-10T00:00:00Z'));
    expect(r.now).toEqual({ a: '2026-09-02T00:00:00.000Z' });
    expect(r.now).toEqual(r.oracle);
    await owner.query(`DELETE FROM telemetry_reading WHERE tenant_id = 'someone-else'`);
  });

  it('randomised: forty fleets of moved devices, closed windows and odd instants — identical to the oracle every time', async () => {
    // Deterministic, so a failure reproduces.
    let seed = 20261012;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const pick = <X>(xs: X[]) => xs[Math.floor(rand() * xs.length)];
    const start = d('2026-07-01T00:00:00Z').getTime();
    const span = 120 * DAY;
    const at = () => new Date(start + Math.floor(rand() * span));

    for (let trial = 0; trial < 40; trial++) {
      await owner.query(`DELETE FROM telemetry_reading WHERE tenant_id = $1`, [T]);
      const imeis = ['I1', 'I2', 'I3'];
      const signals = ['s1', 's2', 's3'];
      for (const imei of imeis) {
        for (const signal of signals) {
          if (rand() < 0.2) continue;
          const from = new Date(start + Math.floor(rand() * span));
          const to = new Date(Math.min(start + span, from.getTime() + Math.floor(rand() * 40 * DAY)));
          await readings(imei, signal, from, to, pick([30, 180, 720]));
        }
      }
      const segments: TelemetrySegment[] = [];
      for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) {
        const from = new Date(start + Math.floor(rand() * span));
        const to = rand() < 0.5 ? null : new Date(from.getTime() + Math.floor(rand() * 30 * DAY) + 1);
        segments.push({ signal: pick(signals), imei: pick(imeis), from, to });
      }
      const instant = at();
      const r = await both(segments, instant);
      expect({ trial, ...r.now }).toEqual({ trial, ...r.oracle });
    }
  }, 120_000);

  // ==================================================================== the work
  /** Rows the plan actually pulled out of `telemetry_reading`, summed over every scan node. */
  const rowsRead = (plan: string) => [...plan.matchAll(/Scan[^\n]*on telemetry_reading_\d{4}_\d{2}[^\n]*actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=(\d+)/g)]
    .reduce((n, m) => n + Number(m[1]) * Number(m[2]), 0);

  it('the rows read do not grow with history: 10 days and 90 days read the same handful', async () => {
    const at = d('2026-10-06T00:00:00Z');
    const signals = ['a', 'b', 'c', 'd', 'e', 'f'];
    const plans: string[] = [];
    for (const days of [10, 90]) {
      await owner.query(`DELETE FROM telemetry_reading WHERE tenant_id = $1`, [T]);
      const from = new Date(at.getTime() - days * DAY);
      for (const s of signals) await readings('I1', s, from, at, 5);
      await owner.query(`ANALYZE telemetry_reading`);
      const segments = signals.map((signal) => ({ signal, imei: 'I1', from, to: null }));
      plans.push(await runTenantSpanning(owner, 'test fixture', (m) => reader.explainLatest(m, T, segments, at)));
    }
    const [short, long] = plans.map(rowsRead);
    expect(short).toBeGreaterThan(0);
    expect(long).toBe(short);
    // One row per segment from the newest partition; nothing like the 155,000 rows the
    // 90-day fixture holds.
    expect(long).toBeLessThanOrEqual(signals.length);
    expect(plans[1]).not.toMatch(/Seq Scan on telemetry_reading/);
  }, 120_000);

  it('partitions outside the bindings are pruned, not merely skipped', async () => {
    const at = d('2026-10-06T00:00:00Z');
    await readings('I1', 'a', d('2026-09-15T00:00:00Z'), at);
    const plan = await runTenantSpanning(owner, 'test fixture', (m) => reader.explainLatest(
      m, T, [{ signal: 'a', imei: 'I1', from: d('2026-09-15T00:00:00Z'), to: null }], at,
    ));
    const named = new Set([...plan.matchAll(/telemetry_reading_(\d{4}_\d{2})/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['2026_09', '2026_10']);
  });
});

/**
 * Coverage's binding reads (QPERF-COVERAGE §2): one query for every requirement, so a
 * class with more requirements does not cost a machine more round trips.
 */
describeDb('coverage query count', () => {
  let owner: DataSource;
  let app: INestApplication;
  const NOW = new Date('2026-10-06T07:00:00.000Z');
  const demo: RequestScope = { tenantId: DEMO_TENANT, userId: 'u', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-latest-reading';
    process.env.AUTH_JWT_ISSUER = 'things-alive-latest-reading-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    await seedDemo(owner, { now: NOW, env: { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv });
  }, 180_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  it('one more requirement on the class costs coverage no more queries', async () => {
    const bindings = app.get(SignalBindingService);
    const runner = Object.getPrototypeOf(owner.createQueryRunner()) as QueryRunner;
    const query = jest.spyOn(runner, 'query');
    const count = async () => {
      query.mockClear();
      const result = await bindings.coverage(demo, { sourceSystem: DEMO_SOURCE, externalId: 'EX-01' }, NOW);
      return { queries: query.mock.calls.length, required: result.covered.length + result.missing.length };
    };
    try {
      const before = await count();
      const [{ version }] = await owner.query(
        `SELECT class_version AS version FROM equipment_profile WHERE tenant_id = $1 AND external_id = 'EX-01'`, [DEMO_TENANT],
      );
      // A declared signal, required again on a second component: a new requirement the
      // database accepts (an undeclared role is refused by ck_sensor_requirement_role_declared).
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, component_scope, criticality, min_count)
           VALUES ($1, $2, 'engine_coolant_temperature', 'second-engine', 'required', 1)`,
        [DEMO_CLASS, version],
      );
      const after = await count();
      expect(after.required).toBe(before.required + 1);
      expect(before.queries).toBeGreaterThan(0);
      expect(after.queries).toBe(before.queries);
    } finally {
      query.mockRestore();
      await owner.query(`DELETE FROM equipment_class_sensor_requirement WHERE component_scope = 'second-engine'`);
    }
  });
});
