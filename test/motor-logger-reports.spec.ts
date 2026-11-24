import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CSV_PAGE } from '../src/motor-ingest/motor-reports';
import { MotorReportsService } from '../src/motor-ingest/motor-reports.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SS = 'ta-2.0';
const PUMP = { sourceSystem: SS, externalId: 'PUMP-01' };
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

jest.setTimeout(60_000);

/**
 * A pump logger's reports (Motor Monitor integration spec, 24 Nov 2026, "Web application
 * features"): data quality, running hours and energy per day, and the readings as CSV.
 * Read from the receiver's per-second rows; each case writes those rows as the receiver
 * and the motor job leave them, placed in time or not yet.
 */
describeDb('motor logger reports', () => {
  let owner: DataSource;
  let ds: DataSource;
  let reports: MotorReportsService;

  /** `count` one-second readings from `seq`, the first at `at`; running ones draw 2 A at 240 V, PF 0.5. */
  const readings = (seq: number, count: number, at: string, running: boolean) => owner.query(
    `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm,
                                       batch_id, received_at, reading_at, time_basis)
     SELECT 'MOTOR_001', $1 + i, $1 + i, 240.0, $3, $4, 40.0, 0, 'b', now(), $2::timestamptz + make_interval(secs => i), 'approximate'
       FROM generate_series(0, $5 - 1) i`,
    [seq, at, running ? 2 : 0, running ? 0.5 : 0, count]);
  const upload = (at: string, boot: number, lost: number, dropped: number) => owner.query(
    `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total, received_at)
     VALUES ('MOTOR_001', 'b', 1, 50, 50, 50, $1, $2, $3, $4)`, [boot, lost, dropped, at]);
  const text = async (stream: Readable) => {
    let out = '';
    for await (const chunk of stream) out += chunk;
    return out;
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    reports = new MotorReportsService(ds);
    for (const t of ['acme', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name, time_zone) VALUES ($1, $1, 'Asia/Kolkata')`, [t]);
      for (const ext of ['PUMP-01', 'PUMP-02']) {
        await owner.query(
          `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ($1, $2, $3, $3, 'client', 'active', 'basic', '{}'::jsonb)`, [t, SS, ext]);
      }
    }
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE motor_sensor_records, motor_upload_log, device_inventory CASCADE`);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'acme', 'assigned', 'PUMP-01')`);
  });

  describe('data quality', () => {
    const FROM = new Date('2026-11-20T00:00:00Z');
    const TO = new Date('2026-11-21T00:00:00Z');

    beforeEach(async () => {
      // seq 100..199 with 150..152 and 170 damaged in flash and skipped by the device.
      await readings(100, 50, '2026-11-20T10:00:00Z', true);
      await readings(153, 17, '2026-11-20T10:00:53Z', true);
      await readings(171, 29, '2026-11-20T10:01:11Z', true);
      // Stored by the receiver, not yet placed in time by the motor job.
      await owner.query(`INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm, batch_id)
                         VALUES ('MOTOR_001', 300, 300, 240, 0, 0, 30, 0, 'b')`);
      // The day before: the baseline the window's first upload grew from.
      await upload('2026-11-19T23:55:00Z', 6, 2, 0);
      await upload('2026-11-20T10:05:00Z', 6, 2, 0);
      // A restart; the device lost three records and failed to store one before it.
      await upload('2026-11-20T11:05:00Z', 7, 5, 1);
      // A retry of the same range carries the same totals and adds nothing.
      await upload('2026-11-20T11:06:00Z', 7, 5, 1);
    });

    it('gaps in seq, restarts, and how much was lost and dropped in the window', async () => {
      const report = await reports.quality(acme, PUMP, FROM, TO);
      expect(report.loggers).toEqual([{
        deviceId: 'MOTOR_001',
        readings: 96, firstSeq: 100, lastSeq: 199, missing: 4,
        gaps: [
          { fromSeq: 150, toSeq: 152, missing: 3, after: '2026-11-20T10:00:49.000Z' },
          { fromSeq: 170, toSeq: 170, missing: 1, after: '2026-11-20T10:01:09.000Z' },
        ],
        gapsTruncated: false,
        awaitingPlacement: 1,
        uploads: 3, lastUploadAt: '2026-11-20T11:06:00.000Z',
        bootFirst: 6, bootLast: 7, restarts: 1,
        lostTotal: 5, droppedTotal: 1, lostInWindow: 3, droppedInWindow: 1,
      }]);
    });

    it('a counter lower than the one before is a reset, and counts whole', async () => {
      await upload('2026-11-20T12:00:00Z', 8, 2, 1);
      const [logger] = (await reports.quality(acme, PUMP, FROM, TO)).loggers;
      expect(logger).toMatchObject({ restarts: 2, lostTotal: 2, lostInWindow: 5 });
    });

    it('a window longer than 31 days, or backwards, is refused', async () => {
      await expect(reports.quality(acme, PUMP, new Date('2026-10-01T00:00:00Z'), TO)).rejects.toBeInstanceOf(BadRequestException);
      await expect(reports.quality(acme, PUMP, TO, FROM)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('running hours and energy per day', () => {
    beforeEach(async () => {
      await upload('2026-11-22T12:00:00Z', 1, 0, 0);
      // 22 Nov in India: an hour running at 240 V x 2 A x PF 0.5, then half an hour stopped.
      await readings(10_000, 3600, '2026-11-22T04:30:00Z', true);
      await readings(13_600, 1800, '2026-11-22T05:30:00Z', false);
      // The last running second of 22 Nov in India, and the first of 23 Nov: midnight
      // there is 18:30 UTC, and the day a second belongs to is the account's.
      await readings(20_000, 1, '2026-11-22T18:29:59Z', true);
      await readings(20_001, 1, '2026-11-22T18:30:00Z', true);
    });

    it('per calendar day in the account\'s time zone; a day with no readings is unknown, not zero', async () => {
      const report = await reports.daily(acme, PUMP, '2026-11-22', '2026-11-24');
      expect(report).toMatchObject({ from: '2026-11-22', to: '2026-11-24', timeZone: 'Asia/Kolkata' });
      expect(report.loggers).toEqual([{
        deviceId: 'MOTOR_001',
        days: [
          // 3601 running seconds: 1.0003 h; 240 x 2 x 0.5 x 3601 s = 0.24007 kWh.
          { date: '2026-11-22', readings: 5401, coverage: 0.0625, runningHours: 1, energyKwh: 0.24 },
          { date: '2026-11-23', readings: 1, coverage: 0, runningHours: 0, energyKwh: 0 },
          { date: '2026-11-24', readings: 0, coverage: 0, runningHours: null, energyKwh: null },
        ],
      }]);
    });

    it('more than 92 days, or from after to, is refused', async () => {
      await expect(reports.daily(acme, PUMP, '2026-01-01', '2026-11-24')).rejects.toBeInstanceOf(BadRequestException);
      await expect(reports.daily(acme, PUMP, '2026-11-24', '2026-11-22')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('readings as CSV', () => {
    it('every reading in the window once, in seq order, across more than one page', async () => {
      await upload('2026-11-22T12:00:00Z', 1, 0, 0);
      await readings(10_000, CSV_PAGE + 400, '2026-11-22T04:30:00Z', true);
      await readings(90_000, 5, '2026-11-23T04:30:00Z', true); // outside the window
      const { name, stream } = await reports.csv(acme, PUMP, undefined,
        new Date('2026-11-22T00:00:00Z'), new Date('2026-11-23T00:00:00Z'));
      expect(name).toBe('MOTOR_001_2026-11-22_2026-11-23.csv');
      const lines = (await text(stream)).trimEnd().split('\r\n');
      expect(lines[0]).toBe('device_id,seq,timestamp,reading_at,time_basis,voltage,current,power_factor,'
        + 'temperature_estimated,rpm_estimated,load_loss,vibration,air_gap');
      expect(lines[1]).toBe('MOTOR_001,10000,10000,2026-11-22T04:30:00Z,approximate,240.0,2.00,0.50,40.0,0,,,');
      const seqs = lines.slice(1).map((l) => Number(l.split(',')[1]));
      expect(seqs).toHaveLength(CSV_PAGE + 400);
      expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)).toBe(true);
    });

    it('a logger not on this machine, or a machine without one, is a 404', async () => {
      await upload('2026-11-22T12:00:00Z', 1, 0, 0);
      await expect(reports.csv(acme, PUMP, 'MOTOR_999', undefined, undefined)).rejects.toBeInstanceOf(NotFoundException);
      await expect(reports.csv(acme, { sourceSystem: SS, externalId: 'PUMP-02' }, undefined, undefined, undefined))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('who sees what', () => {
    beforeEach(async () => {
      await upload('2026-11-20T10:05:00Z', 1, 0, 0);
      await readings(100, 10, '2026-11-20T10:00:00Z', true);
    });
    const FROM = new Date('2026-11-20T00:00:00Z');
    const TO = new Date('2026-11-21T00:00:00Z');

    it('another account\'s machine of the same name shows none of this logger', async () => {
      const globex: RequestScope = { ...acme, tenantId: 'globex', userId: 'u-globex' };
      expect((await reports.quality(globex, PUMP, FROM, TO)).loggers).toEqual([]);
      await expect(reports.csv(globex, PUMP, undefined, FROM, TO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a caller assigned to other machines is told there is no such machine', async () => {
      const operator: RequestScope = { ...acme, roles: ['operational'], equipmentIds: ['PUMP-02'] };
      await expect(reports.quality(operator, PUMP, FROM, TO)).rejects.toBeInstanceOf(NotFoundException);
      await expect(reports.daily(operator, PUMP, '2026-11-20', '2026-11-20')).rejects.toBeInstanceOf(NotFoundException);
      await expect(reports.csv(operator, PUMP, undefined, FROM, TO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a device the receiver heard from but nobody mapped to the machine reports nothing on it', async () => {
      await owner.query(`UPDATE device_inventory SET equipment_external_id = NULL`);
      expect((await reports.quality(acme, PUMP, FROM, TO)).loggers).toEqual([]);
    });
  });
});
