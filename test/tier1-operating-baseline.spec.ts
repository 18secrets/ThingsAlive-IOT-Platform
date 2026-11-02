import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { BaselineService } from '../src/prediction/services/baseline.service';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { scoreTier1 } from '../src/prediction/services/tier1';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SS = 'ta-2.0';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };

describe('Tier 1 scorer: a reading taken while parked', () => {
  const baseline = { signal: 'coolant', mean: 84, stddev: 1, sampleCount: 400 };

  it('is unscored, not-operating, rather than judged against a running baseline', () => {
    const out = scoreTier1({
      requiredSignals: ['coolant'], baselines: [baseline],
      observations: [{ signal: 'coolant', value: 34, at: new Date(), operating: false }],
    });
    expect(out.signals[0]).toMatchObject({ state: 'unscored', reason: 'not-operating', z: null, value: 34 });
    expect(out).toMatchObject({ confidence: 'none', riskScore: 0 });
  });

  it('is scored as before when the gate cannot tell (null) or was not asked (absent)', () => {
    for (const operating of [null, undefined, true]) {
      const out = scoreTier1({
        requiredSignals: ['coolant'], baselines: [baseline],
        observations: [{ signal: 'coolant', value: 86, at: new Date(), operating }],
      });
      // Two σ above a mean of 84: past the 1.5 warning line, short of the 2.5 critical one.
      expect(out.signals[0]).toMatchObject({ state: 'warning' });
      expect(out.signals[0].z).toBeCloseTo(2, 9);
    }
  });
});

/**
 * The Tier 1 baseline learns from operating hours (QFIX-BASELINE, carried from the KPI
 * baseline to Tier 1). Found by uploading thirty days of a healthy excavator: averaging
 * running (~84 °C) and parked (~34 °C) coolant gave a mean of ~59 and σ ≈ 25, so a normal
 * running hydraulic temperature scored HIGH and a real coolant excursion scored normal.
 *
 * Each machine reads the same twenty days, every thirty minutes: in shift (08:00–18:00
 * UTC, every day) the engine runs and coolant alternates 83/85; out of shift it is parked
 * at 33/35. What differs is what the machine can say about operating:
 *   RUN   — a shift schedule and an engine_running_status channel: gated.
 *   BLIND — a schedule but no engine-state channel: cannot tell, so every reading (as before).
 *   FREE  — no schedule: every reading (as before).
 */
describeDb('Tier 1 baseline over operating hours', () => {
  let owner: DataSource;
  let ds: DataSource;
  let baselines: BaselineService;
  let predictions: PredictionService;
  // A Saturday noon: in shift, so the newest reading of each machine is a running one.
  const NOW = new Date('2026-09-12T12:00:00.000Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    baselines = new BaselineService(ds);
    predictions = new PredictionService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const inShift = (t: number) => { const h = new Date(t).getUTCHours(); return h >= 8 && h < 18; };

  const machine = async (ext: string, opts: { shift: boolean; engineState: boolean; parkedAllWindow?: boolean }) => {
    await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
      VALUES ('acme', $1, $2, 'standard', '{}'::jsonb, 'fixture')`, [SS, ext]);
    const signals = ['coolant', ...(opts.engineState ? ['engine_running_status'] : [])];
    for (const signal of signals) {
      await owner.query(`INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
          component_id, origin, imei, canonical_unit, valid_from, valid_to, is_primary, status)
        VALUES ('acme', $1, $2, $3, $3, '', 'physical', $4, 'u', '2026-01-01T00:00:00Z', NULL, true, 'active')`,
      [SS, ext, signal, `${ext}-imei`]);
    }
    if (opts.shift) {
      await owner.query(`INSERT INTO equipment_shift (tenant_id, source_system, external_id, name, start_minute, end_minute, days, time_zone, status)
        VALUES ('acme', $1, $2, 'Day', 480, 1080, '{0,1,2,3,4,5,6}', 'UTC', 'active')`, [SS, ext]);
    }
    const rows: unknown[][] = [];
    let i = 0;
    for (let t = NOW.getTime() - 20 * DAY; t <= NOW.getTime(); t += 30 * 60_000, i++) {
      const on = inShift(t) && !opts.parkedAllWindow;
      rows.push([`${ext}-imei`, 'coolant', (on ? 84 : 34) + (i % 2 === 0 ? -1 : 1), new Date(t)]);
      if (opts.engineState) rows.push([`${ext}-imei`, 'engine_running_status', on ? 1 : 0, new Date(t)]);
    }
    await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      SELECT 'acme', imei, signal, value, 'u', ts, ts, 'live'
        FROM unnest($1::text[], $2::text[], $3::double precision[], $4::timestamptz[]) AS r(imei, signal, value, ts)`,
    [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => (r[3] as Date).toISOString())]);
  };

  const scenario = async (ext: string) => {
    await owner.query(`INSERT INTO client_scenario (tenant_id, slug, client_equipment_class_slug, name, severity, tier,
        required_signals, minimum_history_days, parameters, enabled, template_slug, template_version, template_checksum,
        copied_at, status, updated_by)
      VALUES ('acme', 'coolant-drift', 'excavator', 'Coolant drift', $1, 1, '{coolant}', 0, '[]'::jsonb, true,
        'coolant-drift', 1, 'c', now(), 'active', 'u') ON CONFLICT DO NOTHING`, [Severity.High]);
    await owner.query(`INSERT INTO equipment_scenario (tenant_id, source_system, external_id, client_scenario_slug, state)
      VALUES ('acme', $1, $2, 'coolant-drift', 'active')`, [SS, ext]);
  };

  const reading = (ext: string, signal: string, value: number, at: Date) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     VALUES ('acme', $1, $2, $3, 'u', $4, $4, 'live')`, [`${ext}-imei`, signal, value, at]);

  const coolantBaseline = async (ext: string) =>
    (await baselines.refresh(acme, { sourceSystem: SS, externalId: ext }, 30, NOW)).find((b) => b.signal === 'coolant');

  beforeEach(async () => {
    for (const t of ['prediction', 'prediction_baseline', 'telemetry_reading', 'equipment_scenario', 'client_scenario',
      'equipment_shift', 'signal_binding_version', 'equipment_profile']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  it('1. with a schedule and engine state, the baseline is running coolant only: mean 84, σ about 1', async () => {
    await machine('RUN', { shift: true, engineState: true });
    const b = await coolantBaseline('RUN');
    expect(Number(b!.mean)).toBeCloseTo(84, 0);
    expect(Number(b!.stddev)).toBeLessThan(1.1);
    // Twenty in-shift readings a day, twenty days; none of the parked ones.
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM telemetry_reading
      WHERE imei = 'RUN-imei' AND signal = 'coolant' AND extract(hour FROM source_timestamp AT TIME ZONE 'UTC') BETWEEN 8 AND 17`);
    expect(b!.sampleCount).toBe(n);
  });

  it('2. without engine state, or without a schedule, the baseline is every reading, as before', async () => {
    await machine('BLIND', { shift: true, engineState: false });
    await machine('FREE', { shift: false, engineState: true });
    for (const ext of ['BLIND', 'FREE']) {
      const b = await coolantBaseline(ext);
      expect(Number(b!.mean)).toBeGreaterThan(50);
      expect(Number(b!.mean)).toBeLessThan(65);
      expect(Number(b!.stddev)).toBeGreaterThan(20);
    }
  });

  it('3. a 4 °C rise while running is critical against the running baseline, where the mixed one called it normal', async () => {
    await machine('RUN', { shift: true, engineState: true });
    await machine('BLIND', { shift: true, engineState: false });
    for (const ext of ['RUN', 'BLIND']) {
      await scenario(ext);
      await reading(ext, 'coolant', 88, new Date(NOW.getTime() + 10 * 60_000));
      if (ext === 'RUN') await reading(ext, 'engine_running_status', 1, new Date(NOW.getTime() + 10 * 60_000));
      await coolantBaseline(ext);
    }
    const run = (await predictions.scoreAsset(acme, { sourceSystem: SS, externalId: 'RUN' }, NOW)).written[0];
    expect(run.signals[0]).toMatchObject({ signal: 'coolant', state: 'critical' });
    expect(run.signals[0].z).toBeCloseTo(4, 0);
    const blind = (await predictions.scoreAsset(acme, { sourceSystem: SS, externalId: 'BLIND' }, NOW)).written[0];
    expect(blind.signals[0]).toMatchObject({ signal: 'coolant', state: 'normal' });
  });

  it('4. a parked reading is not scored against the running baseline: no -50σ, no critical at night', async () => {
    await machine('RUN', { shift: true, engineState: true });
    await scenario('RUN');
    await coolantBaseline('RUN');
    const evening = new Date(NOW.getTime() + 8 * HOUR); // 20:00, out of shift
    await reading('RUN', 'engine_running_status', 0, evening);
    await reading('RUN', 'coolant', 34, evening);
    const p = (await predictions.scoreAsset(acme, { sourceSystem: SS, externalId: 'RUN' }, evening)).written[0];
    expect(p.signals[0]).toMatchObject({ state: 'unscored', reason: 'not-operating', z: null });
    expect(p).toMatchObject({ confidence: 'none', riskScore: 0, severity: 'none' });
  });

  it('5. a machine that did not run in the window has no baseline; last refresh\'s every-hour row is removed, not kept', async () => {
    await machine('PARKED', { shift: true, engineState: true, parkedAllWindow: true });
    await owner.query(`INSERT INTO prediction_baseline (tenant_id, source_system, external_id, signal, window_days, mean, stddev,
        sample_count, coverage_ratio, first_sample_at, last_sample_at, source, computed_at)
      VALUES ('acme', $1, 'PARKED', 'coolant', 30, 59, 25, 960, 1, now(), now(), 'live', now())`, [SS]);
    expect(await coolantBaseline('PARKED')).toBeUndefined();
    expect(await owner.query(`SELECT signal FROM prediction_baseline WHERE external_id = 'PARKED'`)).toEqual([]);
  });

  it('6. the refresh is still idempotent: twice gives the same row and the same numbers', async () => {
    await machine('RUN', { shift: true, engineState: true });
    const a = await coolantBaseline('RUN');
    const b = await coolantBaseline('RUN');
    expect(b!.id).toBe(a!.id);
    expect([Number(b!.mean), Number(b!.stddev), b!.sampleCount]).toEqual([Number(a!.mean), Number(a!.stddev), a!.sampleCount]);
  });
});
