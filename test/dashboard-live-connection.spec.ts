import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceHealthService } from '../src/device-health/services/device-health.service';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { ChainService } from '../src/intelligence/services/chain.service';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { PredictionService } from '../src/prediction/services/prediction.service';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { ShiftService } from '../src/shift/services/shift.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { UtilizationService } from '../src/utilization/services/utilization.service';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const IST = 'Asia/Kolkata';
// 06:00–14:00 Kolkata is 00:30–08:30 UTC, so the 14th's window closed before NOW.
const NOW = new Date('2026-09-14T09:00:00.000Z');
const LATER = new Date('2026-09-14T11:00:00.000Z');
const WINDOW_END = '2026-09-14T08:30:00.000Z';
const minutesBefore = (at: Date, minutes: number) => new Date(at.getTime() - minutes * 60_000);

jest.setTimeout(30_000);

/**
 * The dashboard's Connection column, for a motor logger that went quiet (26 Nov 2026).
 *
 * CROMPTON-01's logger stopped uploading at 17:58 on the 25th. The night shift after it
 * closed at 08:00 and was never scored: with no existing-platform connection a window
 * 2.0 holds nothing for stays owed, in case its readings are waiting upstream. So no
 * `dark` verdict was written, the newest one was the day shift's `intermittent`, and the
 * dashboard — reading "anything but dark" as Online — said Online all morning.
 *
 * Two things were wrong, and each is asserted here by the outcome somebody would see:
 *  - a receiver logger posts to 2.0 and nowhere else, so its silent shift is scored as
 *    silence (a `dark` verdict) rather than owed for ever;
 *  - the fleet view says whether the logger is reaching 2.0 now (`live`, by its last
 *    upload, the Live view's rule), not only what the last closed shift was.
 */
describeDb('the dashboard connection of a motor logger that went quiet', () => {
  let ds: DataSource;
  let owner: DataSource;
  let runner: ShiftRunner;
  let shifts: ShiftService;
  let health: DeviceHealthService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'prediction.run', 'device.read'],
  };
  const morning = { name: 'A', startMinute: 6 * 60, endMinute: 14 * 60, days: [0, 1, 2, 3, 4, 5, 6] as any, timeZone: IST };
  const REF = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-7' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    // The fixtures are pinned to September 2026; the migration only builds partitions from
    // two months before the day it runs.
    await owner.query(`SELECT ensure_telemetry_partition('2026-09-01'::date)`);
    ds = await createAppDataSource();
    shifts = new ShiftService(ds);
    health = new DeviceHealthService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
    // No legacy connection, as on dev.
    runner = new ShiftRunner(
      ds, shifts, new LegacyTelemetryReader(ds, null), new TelemetryService(ds),
      new PredictionService(ds, new PredictionWorkRaiser()), new AlertService(ds),
      new UtilizationService(ds), health, new ChainService(ds),
    );
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['causal_chain', 'device_link_health', 'utilization_shift', 'shift_run', 'prediction',
      'telemetry_reading', 'motor_upload_log', 'sensor_map_projection', 'device_projection', 'equipment_shift',
      'signal_binding_version', 'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'PUMP-7', name: 'Pump 7', plantId: north });
    await shifts.create(boss, REF, morning);
  });

  /** A primary, active binding of one signal to a logger on PUMP-7, the way onboarding makes one. */
  const bind = (imei: string, signal = 'supply_voltage') => owner.query(
    `INSERT INTO signal_binding_version
       (tenant_id, source_system, external_id, signal_key, measurement_role, component_id, origin,
        imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
     VALUES ('acme', $1, 'PUMP-7', $2, $2, '', 'physical', $3, $2, 'none', '2026-01-01T00:00:00Z', true, 'active',
             'manual', 'fixture', '2026-01-01T00:00:00Z')`,
    [CLIENT_SOURCE_SYSTEM, signal, imei]);

  /** The motor receiver accepted a batch from this logger at `at`: what makes it a receiver logger. */
  const upload = (imei: string, at: Date) => owner.query(
    `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, received_at)
     VALUES ($1, $2, 1, 60, 60, 60, $3)`, [imei, `${imei}-1-60`, at]);

  /** One reading a minute across the 14th's window, arriving at `arrived`. */
  const reported = (imei: string, arrived: Date) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
     SELECT 'acme', $1, 'supply_voltage', 231, 'V', ts, $2, 'live'
       FROM generate_series('2026-09-14T00:31:00Z'::timestamptz, '2026-09-14T08:29:00Z'::timestamptz, interval '1 minute') ts`,
    [imei, arrived]);

  /** The existing platform maps this logger on PUMP-7: its readings could be waiting there. */
  const knownUpstream = async (imei: string) => {
    await owner.query(
      `INSERT INTO device_projection (source_system, external_id, tenant_id, checksum, imei, equipment_external_id)
       VALUES ($1, $2, 'acme', 'x', $3, 'PUMP-7')`, [CLIENT_SOURCE_SYSTEM, `dev-${imei}`, imei]);
    await owner.query(
      `INSERT INTO sensor_map_projection (source_system, external_id, tenant_id, checksum, imei, signal, unit)
       VALUES ($1, $2, 'acme', 'x', $3, 'supply_voltage', 'V')`, [CLIENT_SOURCE_SYSTEM, `sm-${imei}`, imei]);
  };

  const verdicts = async () => (await owner.query(
    `SELECT imei, state FROM device_link_health ORDER BY imei`)).map((v: { imei: string; state: string }) => [v.imei, v.state]);
  const scoredThrough = async () => {
    const [row] = await owner.query(`SELECT scored_through FROM equipment_shift WHERE external_id = 'PUMP-7'`);
    return row.scored_through ? new Date(row.scored_through).toISOString() : null;
  };

  describe('a silent shift on a machine whose loggers post only to 2.0', () => {
    it('1. is scored as silence: a dark verdict, a utilization row, and the watermark moves', async () => {
      await bind('MOTOR-7');
      await upload('MOTOR-7', new Date('2026-09-13T12:00:00Z'));

      const summary = await runner.run(NOW);
      expect(summary).toMatchObject({ considered: 1, skipped: 1, scored: 0 });
      expect(summary.outcomes[0]).toMatchObject({ status: 'nothing-to-score', detail: 'no-readings' });
      expect(await verdicts()).toEqual([['MOTOR-7', 'dark']]);
      const [util] = await owner.query(`SELECT count(*)::int AS n FROM utilization_shift WHERE external_id = 'PUMP-7'`);
      expect(util.n).toBe(1);
      expect(await scoredThrough()).toBe(WINDOW_END);
      expect(await shifts.owed(NOW)).toHaveLength(0);
    });

    it('2. loses nothing: when the logger\'s buffer arrives later, the shift is scored again from it', async () => {
      await bind('MOTOR-7');
      await upload('MOTOR-7', new Date('2026-09-13T12:00:00Z'));
      await runner.run(NOW);
      expect(await verdicts()).toEqual([['MOTOR-7', 'dark']]);

      // The logger comes back at 10:30 UTC and flushes the whole shift it was holding.
      await reported('MOTOR-7', new Date('2026-09-14T10:30:00Z'));
      expect(await runner.run(LATER)).toMatchObject({ rewound: 1, scored: 1 });
      expect(await verdicts()).toEqual([['MOTOR-7', 'healthy']]);
    });
  });

  describe('a silent shift that still waits, as before', () => {
    it('3. a logger that never uploaded to the receiver: its readings may be upstream, so the shift stays owed', async () => {
      await bind('MOTOR-7');

      const summary = await runner.run(NOW);
      expect(summary.outcomes[0]).toMatchObject({ status: 'nothing-to-score', detail: 'no connection' });
      expect(await verdicts()).toEqual([]);
      expect(await scoredThrough()).toBeNull();
    });

    it('4. a receiver logger the existing platform also maps stays owed', async () => {
      await bind('MOTOR-7');
      await upload('MOTOR-7', new Date('2026-09-13T12:00:00Z'));
      await knownUpstream('MOTOR-7');

      expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ detail: 'no connection' });
      expect(await scoredThrough()).toBeNull();
    });

    it('5. a machine with a receiver logger and another one stays owed: the other\'s readings may be upstream', async () => {
      await bind('MOTOR-7');
      await upload('MOTOR-7', new Date('2026-09-13T12:00:00Z'));
      await bind('861000000000077', 'latitude');

      expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ detail: 'no connection' });
      expect(await scoredThrough()).toBeNull();
    });

    it('6. a machine with no logger bound at all stays owed', async () => {
      expect((await runner.run(NOW)).outcomes[0]).toMatchObject({ detail: 'no connection' });
      expect(await scoredThrough()).toBeNull();
    });
  });

  describe('the fleet view says whether the logger is reaching 2.0 now', () => {
    /** A shift that reported throughout: its verdict is `healthy`, whatever happens after. */
    const healthyShift = async () => {
      await bind('MOTOR-7');
      await reported('MOTOR-7', new Date('2026-09-14T08:29:30Z'));
      await upload('MOTOR-7', new Date('2026-09-14T08:29:30Z'));
      await runner.run(NOW);
      expect(await verdicts()).toEqual([['MOTOR-7', 'healthy']]);
    };
    const row = async (at: Date) => (await health.fleet(boss, {}, at)).find((r) => r.imei === 'MOTOR-7');

    it('7. uploading three minutes ago: online, with when', async () => {
      await healthyShift();
      const uploaded = minutesBefore(LATER, 3);
      await upload('MOTOR-7', uploaded);
      expect(await row(LATER)).toMatchObject({ state: 'healthy', live: 'online', lastUploadAt: uploaded });
    });

    it('8. silent for eleven minutes after a healthy shift: offline, though the shift verdict is still healthy', async () => {
      await healthyShift();
      await upload('MOTOR-7', minutesBefore(LATER, 11));
      expect(await row(LATER)).toMatchObject({ state: 'healthy', live: 'offline' });
    });

    it('9. ten minutes exactly is still online: two missed bursts, not one, is offline', async () => {
      await healthyShift();
      await upload('MOTOR-7', minutesBefore(LATER, 10));
      expect((await row(LATER))?.live).toBe('online');
    });

    it('10. a device that never uploaded to the receiver has no live answer, not a guessed one', async () => {
      // Readings that reached 2.0 by another route: a verdict, and no receiver upload.
      await bind('MOTOR-7');
      await reported('MOTOR-7', new Date('2026-09-14T08:29:30Z'));
      await runner.run(NOW);
      expect(await row(LATER)).toMatchObject({ state: 'healthy', live: null, lastUploadAt: null });
    });
  });
});
