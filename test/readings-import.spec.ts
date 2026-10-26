import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../src/kpi/services/telemetry-window-reader';
import { createApp } from '../src/main';
import { parseCsv, parseInstant, readRows, ReadingsCsvRefusal } from '../src/readings-import/readings-csv';
import { ReadingsImportService } from '../src/readings-import/readings-import.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { bindingSegments } from '../src/signal-binding/services/signal-binding.service';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const NOW = new Date('2026-10-19T10:20:00.000Z');
const SS = 'ta-2.0';
const SECRET = 'test-secret-readings-import';
const ISSUER = 'things-alive-readings-import-test';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const narrow: RequestScope = { ...acme, userId: 'u-narrow', equipmentIds: ['OTHER'] };
const G1 = { sourceSystem: SS, externalId: 'G-1' };

const csv = (...lines: string[]) => ['timestamp,sensor,value,unit', ...lines].join('\n');

describe('readings CSV, the parsing', () => {
  it('reads quoted fields, doubled quotes, CRLF and a byte-order mark', () => {
    expect(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,2,3\n')).toEqual([['a', 'b,c', 'say "hi"'], ['1', '2', '3']]);
  });

  it('refuses a file with an unclosed quote, an empty file, and a missing column', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(ReadingsCsvRefusal);
    expect(() => readRows('\n\n')).toThrow('The file is empty.');
    expect(() => readRows('timestamp,value\n')).toThrow('Missing column(s): sensor');
  });

  it('takes the header in any order and case, and numbers lines as a spreadsheet does', () => {
    expect(readRows('Value,SENSOR,Timestamp\n\n1,s,2026-01-01T00:00:00Z\n')).toEqual([
      { line: 3, timestamp: '2026-01-01T00:00:00Z', sensor: 's', value: '1', unit: null },
    ]);
  });

  it('a timestamp needs a zone; Z, +05:30, +0530 and a space separator are all read', () => {
    expect(parseInstant('2026-09-01T10:00:00')).toEqual({ reason: 'timestamp_without_zone' });
    expect(parseInstant('01/09/2026 10:00')).toEqual({ reason: 'bad_timestamp' });
    for (const s of ['2026-09-01T04:30:00Z', '2026-09-01T10:00:00+05:30', '2026-09-01 10:00:00+0530', '2026-09-01T04:30z']) {
      expect(parseInstant(s)).toEqual({ at: new Date('2026-09-01T04:30:00.000Z') });
    }
  });
});

/**
 * Historical readings uploaded per machine (task QIMPORT-READINGS). The point of an
 * upload is that the platform reads it like any other history, so what is tested is
 * where each row lands (the binding in force at its time), that nothing else is touched
 * (no partial loads, no overwritten live reading, no other machine), that a reload adds
 * nothing even when two run at once, and that the readers then see it.
 */
describeDb('readings import: one machine\'s history from a CSV', () => {
  let owner: DataSource;
  let app: INestApplication;
  let svc: ReadingsImportService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    svc = app.get(ReadingsImportService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  /**
   * acme G-1: coolant moved from device OLD to NEW on 1 June; oil on one device all year.
   * globex G-2: coolant bound, so a wrong tenant would have somewhere to land.
   */
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "telemetry_reading", "signal_binding_version", "equipment_profile" CASCADE`);
    for (const [tenant, ext] of [['acme', 'G-1'], ['globex', 'G-2']] as const) {
      await runTenantSpanning(owner, 'fixture', (m) => m.getRepository(EquipmentProfile).save({
        tenantId: tenant, sourceSystem: SS, externalId: ext, equipmentClassSlug: null, classVersion: null, plantId: null,
        tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u', name: ext,
      }));
    }
    const bind = (tenant: string, ext: string, signal: string, imei: string, unit: string, from: string, to: string | null) => owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
         component_id, origin, imei, canonical_unit, valid_from, valid_to, is_primary, status)
       VALUES ($1, $2, $3, $4, $4, '', 'physical', $5, $6, $7, $8, true, 'active')`, [tenant, SS, ext, signal, imei, unit, from, to]);
    // Instants, not dates: a bare '2026-06-01' is midnight in the session's zone, not UTC.
    await bind('acme', 'G-1', 'engine_coolant_temperature', 'OLD', 'degC', '2025-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
    await bind('acme', 'G-1', 'engine_coolant_temperature', 'NEW', 'degC', '2026-06-01T00:00:00Z', null);
    await bind('acme', 'G-1', 'engine_oil_pressure', 'OIL', 'kPa', '2025-01-01T00:00:00Z', null);
    await bind('globex', 'G-2', 'engine_coolant_temperature', 'G2', 'degC', '2025-01-01T00:00:00Z', null);
  }, 60_000);

  const stored = () => owner.query(
    `SELECT tenant_id, imei, signal, value, unit, source, source_timestamp FROM telemetry_reading ORDER BY source_timestamp, imei`);

  const GOOD = csv(
    '2026-05-31T23:00:00Z,engine_coolant_temperature,81.5,degC',
    // 06:00 in India is 00:30 UTC on 1 June: after the swap, so NEW. (01:00 +05:30 would be 31 May, OLD.)
    '2026-06-01T06:00:00+05:30,engine_coolant_temperature,82,degc',
    '2026-09-01 10:00:00+0530,engine_oil_pressure,410,',
    '2025-02-01T00:00:00Z,engine_oil_pressure,400,kPa',
  );

  it('1. plan writes nothing and says, per sensor, what apply would store and where', async () => {
    const report = await svc.plan(acme, G1, GOOD, NOW);
    expect(report).toMatchObject({ source: 'replayed', rows: 4, valid: 4, alreadyStored: 0, refused: { count: 0, rows: [] } });
    expect(report.sensors).toEqual([
      { sensor: 'engine_coolant_temperature', signal: 'engine_coolant_temperature', imei: 'NEW', unit: 'degC', rows: 1,
        from: '2026-06-01T00:30:00.000Z', to: '2026-06-01T00:30:00.000Z' },
      { sensor: 'engine_coolant_temperature', signal: 'engine_coolant_temperature', imei: 'OLD', unit: 'degC', rows: 1,
        from: '2026-05-31T23:00:00.000Z', to: '2026-05-31T23:00:00.000Z' },
      { sensor: 'engine_oil_pressure', signal: 'engine_oil_pressure', imei: 'OIL', unit: 'kPa', rows: 2,
        from: '2025-02-01T00:00:00.000Z', to: '2026-09-01T04:30:00.000Z' },
    ].sort((a, b) => a.signal.localeCompare(b.signal) || a.imei.localeCompare(b.imei)));
    expect(await stored()).toEqual([]);
  });

  it('2. every refusal is named with its line, and apply with any refusal stores nothing (422)', async () => {
    const BAD = csv(
      '2026-09-01T00:00:00Z,engine_oil_pressure,410,kPa', // line 2: fine
      '2026-09-01T00:00:00Z,engine_oil_pressure,,kPa', // 3
      'yesterday,engine_oil_pressure,1,', // 4
      '2026-09-01T00:00:00,engine_oil_pressure,1,', // 5
      '2026-10-19T11:00:00Z,engine_oil_pressure,1,', // 6: forty minutes ahead
      '2024-09-30T23:00:00Z,engine_oil_pressure,1,', // 7: before 2024-10-01
      '2026-09-01T01:00:00Z,engine_oil_pressure,high,', // 8
      '2026-09-01T01:00:00Z,fuel_level,50,%', // 9
      '2024-12-31T00:00:00Z,engine_coolant_temperature,80,', // 10: before any coolant binding
      '2026-09-01T02:00:00Z,engine_oil_pressure,4.1,bar', // 11
      '2026-09-01T00:00:00Z,engine_oil_pressure,411,kPa', // 12: same as line 2
    );
    const report = await svc.plan(acme, G1, BAD, NOW);
    expect(report.refused.rows.map((r) => [r.line, r.reason])).toEqual([
      [3, 'missing_field'], [4, 'bad_timestamp'], [5, 'timestamp_without_zone'], [6, 'in_the_future'],
      [7, 'older_than_backfill_limit'], [8, 'not_a_number'], [9, 'unknown_sensor'], [10, 'no_binding_at_time'],
      [11, 'unit_mismatch'], [12, 'duplicate_in_file'],
    ]);
    expect(report.refused.rows.find((r) => r.reason === 'unknown_sensor')!.detail)
      .toContain('bound: engine_coolant_temperature, engine_oil_pressure');
    await expect(svc.apply(acme, G1, BAD, NOW)).rejects.toMatchObject({ status: 422 });
    expect(await stored()).toEqual([]);
  });

  it('3. apply stores each row under the binding in force at its time, as replayed, in the binding\'s unit, in a month it had to build', async () => {
    const report = await svc.apply(acme, G1, GOOD, NOW);
    expect(report).toMatchObject({ inserted: 4, duplicates: 0 });
    const rows = await stored();
    expect(rows.map((r: { imei: string; value: number; unit: string; source: string; tenant_id: string }) =>
      [r.imei, r.value, r.unit, r.source, r.tenant_id])).toEqual([
      ['OIL', 400, 'kPa', 'replayed', 'acme'],
      ['OLD', 81.5, 'degC', 'replayed', 'acme'],
      ['NEW', 82, 'degC', 'replayed', 'acme'],
      ['OIL', 410, 'kPa', 'replayed', 'acme'],
    ]);
    // February 2025 is outside the migration's partition buffer: apply built it.
    expect((await owner.query(`SELECT to_regclass('telemetry_reading_2025_02') AS t`))[0].t).toBe('telemetry_reading_2025_02');
  });

  it('4. a reload stores nothing new, and the plan says so first', async () => {
    await svc.apply(acme, G1, GOOD, NOW);
    expect((await svc.plan(acme, G1, GOOD, NOW)).alreadyStored).toBe(4);
    expect(await svc.apply(acme, G1, GOOD, NOW)).toMatchObject({ inserted: 0, duplicates: 4 });
    expect(await stored()).toHaveLength(4);
  });

  it('5. two applies of the same file at once both settle, and each reading is stored once', async () => {
    const results = await Promise.allSettled([svc.apply(acme, G1, GOOD, NOW), svc.apply(acme, G1, GOOD, NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const inserted = results.map((r) => (r as PromiseFulfilledResult<{ inserted: number }>).value.inserted);
    expect(inserted[0] + inserted[1]).toBe(4);
    expect(await stored()).toHaveLength(4);
  });

  it('6. an upload never replaces a live reading at the same time: the live one stays, the row counts as a duplicate', async () => {
    await owner.query(`INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
      VALUES ('acme', 'OIL', 'engine_oil_pressure', 999, 'kPa', '2026-09-01T04:30:00Z', now(), 'live')`);
    expect(await svc.apply(acme, G1, GOOD, NOW)).toMatchObject({ inserted: 3, duplicates: 1 });
    const [live] = await owner.query(`SELECT value, source FROM telemetry_reading WHERE source_timestamp = '2026-09-01T04:30:00Z'`);
    expect(live).toEqual({ value: 999, source: 'live' });
  });

  it('7. the platform reads an uploaded hour as it reads a live one: the newest coolant reading is the uploaded one', async () => {
    await svc.apply(acme, G1, GOOD, NOW);
    const latest = await withTenantId(owner, 'acme', async (m) => {
      const segments = await bindingSegments(m, 'acme', G1, ['engine_coolant_temperature'], { by: 'signalKey' });
      return new TelemetryWindowReader().latestPerSignalInSegments(m, 'acme', segments, NOW);
    });
    expect(latest.get('engine_coolant_temperature')!.toISOString()).toBe('2026-06-01T00:30:00.000Z');
  });

  it('8. another account\'s machine, a machine outside the caller\'s scope and no machine at all are the same 404, and nothing is stored', async () => {
    const g2 = { sourceSystem: SS, externalId: 'G-2' };
    await expect(svc.apply(acme, g2, GOOD, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.apply(narrow, G1, GOOD, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.plan(acme, { sourceSystem: SS, externalId: 'NOPE' }, GOOD, NOW)).rejects.toMatchObject({ status: 404 });
    expect(await stored()).toEqual([]);
  });

  describe('over HTTP', () => {
    const auth = async (roles: string[]) => `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000e1', client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER })}`;
    const base = `/api/v1/equipment/${SS}/G-1/readings`;
    // Dated relative to the real clock, which HTTP uses: a fixed date would drift past the backfill limit.
    const recent = () => csv(`${new Date(Date.now() - 86_400_000).toISOString()},engine_oil_pressure,405,kPa`);

    it('9. plan and apply over multipart: 200 with the report, then stored', async () => {
      const plan = await request(app.getHttpServer()).post(`${base}/import/plan`)
        .set('Authorization', await auth(['admin'])).attach('file', Buffer.from(recent()), 'readings.csv');
      expect(plan.status).toBe(200);
      expect(plan.body).toMatchObject({ valid: 1, refused: { count: 0 } });
      const apply = await request(app.getHttpServer()).post(`${base}/import`)
        .set('Authorization', await auth(['admin'])).attach('file', Buffer.from(recent()), 'readings.csv');
      expect(apply.status).toBe(200);
      expect(apply.body).toMatchObject({ inserted: 1 });
    });

    it('10. a refused row is 422 rows_refused; a broken file or none is 400', async () => {
      const bad = await request(app.getHttpServer()).post(`${base}/import`)
        .set('Authorization', await auth(['admin'])).attach('file', Buffer.from(csv('x,engine_oil_pressure,1,')), 'r.csv');
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('rows_refused');
      const noColumn = await request(app.getHttpServer()).post(`${base}/import/plan`)
        .set('Authorization', await auth(['admin'])).attach('file', Buffer.from('timestamp,value\n'), 'r.csv');
      expect(noColumn.status).toBe(400);
      expect((await request(app.getHttpServer()).post(`${base}/import`).set('Authorization', await auth(['admin']))).status).toBe(400);
      expect(await stored()).toEqual([]);
    });

    it('11. a role without equipment.write is refused and stores nothing', async () => {
      const r = await request(app.getHttpServer()).post(`${base}/import`)
        .set('Authorization', await auth(['operational'])).attach('file', Buffer.from(recent()), 'readings.csv');
      expect(r.status).toBe(403);
      expect(await stored()).toEqual([]);
    });

    it('12. the template names the machine\'s bound sensors and their units', async () => {
      const r = await request(app.getHttpServer()).get(`${base}/import-template`).set('Authorization', await auth(['admin']));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      expect(r.text).toBe('timestamp,sensor,value,unit\n,engine_coolant_temperature,,degC\n,engine_oil_pressure,,kPa\n');
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it('13. PartitionAsOwner1762200000000 down: ta_app can no longer build a month, and the import says so; up restores it', async () => {
    const app_ = app.get(DataSource);
    await undoMigrationNamed(owner, 'PartitionAsOwner1762200000000');
    await expect(app_.query(`SELECT ensure_telemetry_partition('2025-03-01'::date)`)).rejects.toThrow('permission denied');
    await expect(svc.apply(acme, G1, csv('2025-03-02T00:00:00Z,engine_oil_pressure,401,kPa'), NOW)).rejects.toThrow('permission denied');
    expect(await stored()).toEqual([]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await svc.apply(acme, G1, csv('2025-03-02T00:00:00Z,engine_oil_pressure,401,kPa'), NOW)).toMatchObject({ inserted: 1 });
  });
});
