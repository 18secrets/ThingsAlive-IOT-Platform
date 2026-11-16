import { DataSource } from 'typeorm';
import { DtcEpisodeService, MAX_HISTORY_ITEMS, faultPeriod } from '../src/diagnostics/services/dtc-episode.service';
import { retentionDays } from '../src/diagnostics/services/fault-history-prune.scheduler';
import { recordMotorFaults } from '../src/motor-ingest/motor-fault-codes';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { FaultSample, deviceFaults } from '../src/motor-ingest/p-code-rules';
import { batches, expectedFaults, simulate } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorPCodes1765200000000';

jest.setTimeout(60_000);

/**
 * The pump logger's P-codes, worked out by 2.0 from the readings the logger uploads, by
 * the rules the device itself uses for its Bluetooth `/faults` (hardware team, 30 Oct
 * 2026). The HTTP upload carries no codes, so if these drift from the device's rules the
 * website and the mobile app disagree about the same pump.
 */
describe('the device\'s P-code rules', () => {
  const T0 = Date.parse('2026-11-16T10:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000);
  const run = (rows: [voltage: number, current: number, temperature?: number][], rated: number | null = 5.5, startS = 0) =>
    deviceFaults(rows.map(([voltage, current, temperature = 40], i): FaultSample => ({ at: at(startS + i), voltage, current, temperature })), rated)
      .map((t) => [...t.active].sort().join(','));

  it('a code is active only from its third sample in a row, and clears on the first without it', () => {
    expect(run([[185, 4.7], [185, 4.7], [185, 4.7], [185, 4.7], [200, 4.7]])).toEqual(['', '', 'P101', 'P101', '']);
    // Two low samples, a normal one, two low again: never three in a row, never raised.
    expect(run([[185, 4.7], [185, 4.7], [200, 4.7], [185, 4.7], [185, 4.7]])).toEqual(['', '', '', '', '']);
  });

  it('low voltage needs the supply present; a dead supply is not P101', () => {
    expect(run([[0, 0], [0, 0], [0, 0], [20, 0]])).toEqual(['', '', '', '']);
  });

  it('current codes wait out the five seconds after a start: inrush is not a locked rotor', () => {
    // Stopped, then started straight into 3.3 × rated. Grace covers seconds 1–5 of the run.
    const rows: [number, number][] = [[230, 0], ...Array(10).fill([230, 18.2])];
    const active = run(rows);
    expect(active.slice(0, 8).every((a) => !a.includes('P708'))).toBe(true);
    // 5 s of grace, then three samples to become active.
    expect(active[8]).toBe('P702,P708');
  });

  it('a gap in the readings breaks the row: what the pump did in between is not known', () => {
    const samples: FaultSample[] = [0, 1, 20, 21].map((s) => ({ at: at(s), voltage: 260, current: 4.7, temperature: 40 }));
    expect(deviceFaults(samples, 5.5).map((t) => [...t.active].join())).toEqual(['', '', '', '']);
  });

  it('with no rated current, no current-based code is raised at all — never a guessed rating', () => {
    const rows: [number, number][] = Array(10).fill([230, 1]);
    expect(run(rows, null, 100).every((a) => a === '')).toBe(true);
    expect(run(rows, 5.5, 100).slice(-1)[0]).toBe('P401');
  });

  it('the simulator\'s scenarios raise the codes the hardware team says the device sends', () => {
    const END = Math.floor(T0 / 1000);
    const codes = (scenario: Parameters<typeof simulate>[0]) =>
      [...new Set(expectedFaults(simulate(scenario, 30 * 60, END, END - 31 * 60), 5.5)!.map((f) => f.code))].sort();
    expect(codes('normal')).toEqual([]);
    expect(codes('low-voltage')).toEqual(['P101']);
    expect(codes('high-voltage')).toEqual(['P102']);
    expect(codes('dry-run')).toEqual(['P401']);
    expect(codes('overload')).toEqual(['P207', 'P702']);
    expect(codes('locked-rotor')).toEqual(['P207', 'P702', 'P708']);
  });
});

describeDb('P-codes on the machine page, against the database', () => {
  const TENANT = 'motors';
  const NOW = new Date('2026-11-16T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);
  let owner: DataSource;
  let ds: DataSource;
  let motors: MotorIngestService;
  let faults: DtcEpisodeService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-11-01'::date)`);
    ds = await createAppDataSource();
    motors = new MotorIngestService(ds);
    faults = new DtcEpisodeService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory",
      "tenant_parameter", "device_dtc_episode" CASCADE`);
    await owner.query(`DELETE FROM "equipment_profile"`);
    const [{ id }] = await owner.query(
      `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING "id"`, [TENANT]);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', $1, 'assigned', 'PUMP-1')`, [TENANT]);
    for (const [name, value, unit] of [['rated_current', 5.5, 'A'], ['rated_voltage', 220, 'V']] as const) {
      await owner.query(
        `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ($1, 'equipment', $2, $3, $4::jsonb, $5, '2026-01-01', 'test')`, [TENANT, id, name, JSON.stringify(value), unit]);
    }
  });

  /** What the receiver writes for these readings: the records and one upload row a batch. */
  const store = async (records: ReturnType<typeof simulate>) => {
    for (const b of batches('MOTOR_001', records, 0)) {
      for (const r of b.records) {
        await owner.query(
          `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm, batch_id, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [b.device_id, r.seq, r.timestamp, r.voltage, r.current, r.power_factor, r.temperature, r.rpm, b.batch_id,
            new Date((b.records[b.records.length - 1].seq + 1) * 1000)]);
      }
      await owner.query(
        `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, 1, 0, 0, $6)`,
        [b.device_id, b.batch_id, b.first_seq, b.last_seq, b.count, new Date((b.last_seq + 1) * 1000)]);
    }
  };
  const page = () => faults.getEquipmentFaults(TENANT, 'ta-2.0', 'PUMP-1');
  const episodes = () => owner.query(
    `SELECT code, status FROM device_dtc_episode WHERE protocol = 'pcode' ORDER BY code, first_seen_at`,
  ) as Promise<{ code: string; status: string }[]>;

  it('a locked rotor shows on the machine page as P708, with the hardware team\'s title and fix', async () => {
    await store(simulate('locked-rotor', 10 * 60, END, END - 11 * 60));
    const pass = await motors.processPending(NOW);
    expect(pass.faults?.opened).toBeGreaterThanOrEqual(3);
    const shown = await page();
    expect(shown.reportsFaults).toBe(true);
    const p708 = shown.active.find((f) => f.code === 'P708');
    expect(p708).toMatchObject({ protocol: 'pcode', description: 'Locked rotor', lamp: 'red_stop', severity: 'critical' });
    expect(p708?.remedies).toMatch(/capacitor/);
    // Red lamp first, as for a vehicle's codes.
    expect(shown.active.map((f) => f.code).sort()).toEqual(['P207', 'P702', 'P708']);
    expect(shown.active[shown.active.length - 1].lamp).toBe('amber_warning');
  });

  it('a pump logger with no faults reads healthy, not as a machine without fault reporting', async () => {
    await store(simulate('normal', 5 * 60, END, END - 6 * 60));
    await motors.processPending(NOW);
    expect(await page()).toEqual({ reportsFaults: true, active: [], history: [] });
  });

  it('a dry run clears at the first reading without it, once water is back', async () => {
    await store(simulate('dry-run', 10 * 60, END - 5 * 60, END - 16 * 60));
    await motors.processPending(NOW);
    expect(await episodes()).toEqual([{ code: 'P401', status: 'active' }]);
    // Water back: the next five minutes run normally, on the same boot.
    await store(simulate('normal', 5 * 60, END, END - 16 * 60));
    await motors.processPending(NOW);
    expect(await episodes()).toEqual([{ code: 'P401', status: 'cleared' }]);
    const shown = await page();
    expect(shown.active).toEqual([]);
    expect(shown.history.map((f) => f.code)).toEqual(['P401']);
  });

  it('judging the same readings again writes nothing twice', async () => {
    await store(simulate('dry-run', 10 * 60, END, END - 11 * 60));
    await motors.processPending(NOW);
    const before = await owner.query(`SELECT id, last_seen_at, status FROM device_dtc_episode ORDER BY id`);
    const again = await recordMotorFaults(ds, {
      tenantId: TENANT, externalId: 'PUMP-1', deviceId: 'MOTOR_001', from: new Date((END - 600) * 1000), to: NOW,
    });
    expect(again).toEqual({ opened: 0, cleared: 0 });
    expect(await owner.query(`SELECT id, last_seen_at, status FROM device_dtc_episode ORDER BY id`)).toEqual(before);
  });

  it('two passes over the same readings, fired together, both settle and open each code once', async () => {
    await store(simulate('locked-rotor', 10 * 60, END, END - 11 * 60));
    await motors.processPending(NOW);
    await owner.query(`TRUNCATE "device_dtc_episode"`);
    const machine = { tenantId: TENANT, externalId: 'PUMP-1', deviceId: 'MOTOR_001', from: new Date((END - 600) * 1000), to: NOW };
    const results = await Promise.allSettled([recordMotorFaults(ds, machine), recordMotorFaults(ds, machine)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const opened = results.map((r) => (r as PromiseFulfilledResult<{ opened: number }>).value.opened);
    expect(opened.sort()).toEqual([0, 3]);
    expect(await episodes()).toEqual([
      { code: 'P207', status: 'active' }, { code: 'P702', status: 'active' }, { code: 'P708', status: 'active' },
    ]);
  });

  it('1.0\'s DTC clearing leaves a pump\'s P-codes alone: it cannot know about them', async () => {
    await store(simulate('dry-run', 10 * 60, END, END - 11 * 60));
    await motors.processPending(NOW);
    const cleared = await faults.sweepClears(TENANT, 'ta-2.0', 'PUMP-1', new Date(NOW.getTime() + 60 * 60_000));
    expect(cleared).toEqual([]);
    expect(await episodes()).toEqual([{ code: 'P401', status: 'active' }]);
  });

  it('another account cannot see the pump\'s codes', async () => {
    await store(simulate('dry-run', 10 * 60, END, END - 11 * 60));
    await motors.processPending(NOW);
    expect(await faults.getEquipmentFaults('acme', 'ta-2.0', 'PUMP-1')).toEqual({ reportsFaults: false, active: [], history: [] });
  });

  describe('cleared codes by period, and how long they are kept', () => {
    const DAY = 86_400_000;
    /** One episode on the pump, cleared `clearedDaysAgo` days ago (null: still active). */
    const episode = (code: string, clearedDaysAgo: number | null, seenDaysAgo = clearedDaysAgo ?? 0) => owner.query(
      `INSERT INTO device_dtc_episode (tenant_id, source_system, external_id, imei, protocol, code, status,
         first_seen_at, last_seen_at, cleared_at)
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'MOTOR_001', 'pcode', $2, $3, $4, $4, $5)`,
      [TENANT, code, clearedDaysAgo === null ? 'active' : 'cleared', new Date(Date.now() - seenDaysAgo * DAY),
        clearedDaysAgo === null ? null : new Date(Date.now() - clearedDaysAgo * DAY)],
    );
    const lastDays = (days: number) => ({ from: new Date(Date.now() - days * DAY), to: new Date() });

    beforeEach(async () => {
      // The page asks for a pump's codes only once its logger has uploaded.
      await store(simulate('normal', 60, END, END - 120));
    });

    it('a period shows the codes cleared in it, and every active code however old', async () => {
      await episode('P101', 2);
      await episode('P401', 30);
      await episode('P708', null, 200);
      const week = await faults.getEquipmentFaults(TENANT, 'ta-2.0', 'PUMP-1', lastDays(7));
      expect(week.active.map((f) => f.code)).toEqual(['P708']);
      expect(week.history.map((f) => f.code)).toEqual(['P101']);
      expect(week.historyWindow?.from).toBeDefined();
      expect(week.historyTruncated).toBe(false);
      const twoMonths = await faults.getEquipmentFaults(TENANT, 'ta-2.0', 'PUMP-1', lastDays(60));
      expect(twoMonths.history.map((f) => f.code)).toEqual(['P101', 'P401']);
    });

    it('a period with more cleared codes than one answer carries says it was cut, keeping the newest', async () => {
      await owner.query(
        `INSERT INTO device_dtc_episode (tenant_id, source_system, external_id, imei, protocol, code, status,
           first_seen_at, last_seen_at, cleared_at)
         SELECT $1, 'ta-2.0', 'PUMP-1', 'MOTOR_001', 'pcode', 'P702', 'cleared',
                now() - make_interval(mins => n + 1), now() - make_interval(mins => n + 1), now() - make_interval(mins => n)
           FROM generate_series(1, $2::int) n`, [TENANT, MAX_HISTORY_ITEMS + 1]);
      const shown = await faults.getEquipmentFaults(TENANT, 'ta-2.0', 'PUMP-1', lastDays(7));
      expect(shown.history).toHaveLength(MAX_HISTORY_ITEMS);
      expect(shown.historyTruncated).toBe(true);
      const newest = shown.history.map((f) => Date.parse(f.clearedAt!));
      expect(newest).toEqual([...newest].sort((a, b) => b - a));
    });

    it('a period with one end, a date that is not one, or ends in the wrong order is refused', () => {
      expect(() => faultPeriod('2026-11-01T00:00:00Z', undefined)).toThrow(/both from and to/);
      expect(() => faultPeriod('yesterday', '2026-11-16T00:00:00Z')).toThrow(/ISO dates/);
      expect(() => faultPeriod('2026-11-16T00:00:00Z', '2026-11-01T00:00:00Z')).toThrow(/not be after/);
      expect(faultPeriod(undefined, undefined)).toBeUndefined();
    });

    it('cleanup deletes codes cleared past retention, and never an active one however old', async () => {
      await episode('P101', 100);
      await episode('P401', 10);
      await episode('P708', null, 200);
      expect(await faults.pruneHistory(90)).toBe(1);
      expect((await owner.query(`SELECT code, status FROM device_dtc_episode ORDER BY code`)))
        .toEqual([{ code: 'P401', status: 'cleared' }, { code: 'P708', status: 'active' }]);
    });

    it('two cleanups fired together both settle and delete each code once', async () => {
      await episode('P101', 100);
      await episode('P102', 120);
      const results = await Promise.allSettled([faults.pruneHistory(90), faults.pruneHistory(90)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const deleted = results.map((r) => (r as PromiseFulfilledResult<number>).value);
      expect(deleted.reduce((a, b) => a + b, 0)).toBe(2);
      expect(await owner.query(`SELECT 1 FROM device_dtc_episode`)).toHaveLength(0);
    });

    it('retention comes from the environment, but never as zero or nonsense, which would delete today\'s codes', () => {
      expect(retentionDays(undefined)).toBe(90);
      expect(retentionDays('180')).toBe(180);
      expect(retentionDays('0')).toBe(90);
      expect(retentionDays('-5')).toBe(90);
      expect(retentionDays('a year')).toBe(90);
    });
  });

  it(`${MIGRATION} comes off and goes back on`, async () => {
    const tryPcode = () => owner.query(
      `INSERT INTO device_dtc_episode (tenant_id, external_id, imei, protocol, code, first_seen_at, last_seen_at)
       VALUES ($1, 'PUMP-1', 'MOTOR_001', 'pcode', 'P101', now(), now())`, [TENANT]);
    await undoMigrationNamed(owner, MIGRATION);
    await expect(tryPcode()).rejects.toThrow(/ck_device_dtc_episode_protocol/);
    expect(await owner.query(`SELECT 1 FROM dtc_master_catalog WHERE protocol = 'pcode'`)).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    await expect(tryPcode()).resolves.toBeDefined();
    expect(await owner.query(`SELECT code FROM dtc_master_catalog WHERE protocol = 'pcode' ORDER BY code`))
      .toEqual(['P101', 'P102', 'P207', 'P401', 'P702', 'P708'].map((code) => ({ code })));
  });
});
