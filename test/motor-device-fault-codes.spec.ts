import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { recordMotorFaults } from '../src/motor-ingest/motor-fault-codes';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

jest.setTimeout(60_000);

/**
 * A pump's fault codes are the logger's, not 2.0's (the user's decision, 25 Nov 2026):
 * the logger names the codes it holds active in every record, and 2.0 records exactly
 * those. These tests prove 2.0 no longer second-guesses the device from voltage and
 * current, that a record which says nothing about faults changes nothing, and that the
 * old threshold settings cannot be set again.
 */
describeDb('motor fault codes come from the device', () => {
  const TENANT = 'motors';
  const T0 = Date.parse('2026-11-25T10:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000);
  let owner: DataSource;
  let ds: DataSource;
  let seq = 0;

  /**
   * `n` seconds from second `startS`, each with the given readings and the device's
   * `faults` for it (null: the firmware did not send the field).
   */
  const seconds = async (startS: number, n: number, faults: string[] | null, volts = 230, amps = 4.7, temp = 40) => {
    await owner.query(
      `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm,
                                         batch_id, received_at, reading_at, time_basis, device_faults)
       SELECT 'MOTOR_001', $1 + i, $1 + i, $2, $3, 0.8, $4, 2800, 'b', now(),
              $5::timestamptz + make_interval(secs => i), 'approximate', $6::text[]
         FROM generate_series(0, $7 - 1) i`, [seq, volts, amps, temp, at(startS), faults, n]);
    seq += n;
  };
  const judge = (fromS: number, toS: number) =>
    recordMotorFaults(ds, { tenantId: TENANT, externalId: 'PUMP-1', deviceId: 'MOTOR_001', from: at(fromS), to: at(toS) });
  const episodes = () => owner.query(
    `SELECT code, status, lamp_status AS lamp, severity FROM device_dtc_episode WHERE protocol = 'pcode' ORDER BY code, first_seen_at`);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    seq = 0;
    await owner.query(`TRUNCATE "motor_sensor_records", "device_inventory", "device_dtc_episode", "fault_code_type_grant",
      "domain_event" CASCADE`);
    await owner.query(`DELETE FROM "equipment_profile"`);
    await owner.query(
      `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness")
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'basic', '{}')`, [TENANT]);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', $1, 'assigned', 'PUMP-1')`, [TENANT]);
    await owner.query(`INSERT INTO fault_code_type_grant (tenant_id, code_type, granted_by) VALUES ($1, 'motor-pump', 'test')`, [TENANT]);
  });

  it('readings 2.0 used to call a locked rotor raise nothing when the device reports no fault', async () => {
    // 150 V, 18 A, 95 °C for a minute: P101, P207, P702 and P708 by the old rules, with any
    // rating. The device says none is active, and the device is the one that knows.
    await seconds(0, 60, [], 150, 18, 95);
    expect(await judge(0, 60)).toEqual({ opened: 0, cleared: 0 });
    expect(await episodes()).toEqual([]);
  });

  it('records the codes the device reports, and clears each at the first record without it', async () => {
    await seconds(0, 10, ['P101', 'P702']);
    await seconds(10, 5, ['P702']);
    await seconds(15, 5, []);
    expect(await judge(0, 20)).toEqual({ opened: 2, cleared: 2 });
    expect(await episodes()).toEqual([
      { code: 'P101', status: 'cleared', lamp: 'amber_warning', severity: 'high' },
      { code: 'P702', status: 'cleared', lamp: 'amber_warning', severity: 'high' },
    ]);
  });

  it('a record that says nothing about faults neither opens nor clears anything', async () => {
    await seconds(0, 5, ['P401']);
    await seconds(5, 30, null);   // older firmware, or a field the receiver could not read
    await judge(0, 35);
    expect((await episodes()).map((e: { status: string }) => e.status)).toEqual(['active']);
    await seconds(35, 1, []);     // the device says it has gone
    await judge(35, 36);
    expect((await episodes()).map((e: { status: string }) => e.status)).toEqual(['cleared']);
  });

  it('only "not said" records: nothing is judged, not even a pass', async () => {
    await seconds(0, 60, null, 150, 18, 95);
    expect(await judge(0, 60)).toEqual({ opened: 0, cleared: 0 });
    expect(await episodes()).toEqual([]);
  });

  it('a code the library does not list is recorded under its own name, emailed, and cleared like any other', async () => {
    await seconds(0, 5, ['P999']);
    await seconds(5, 1, []);
    await judge(0, 6);
    expect(await episodes()).toEqual([{ code: 'P999', status: 'cleared', lamp: 'amber_warning', severity: 'high' }]);
    const [event] = await owner.query(
      `SELECT payload->>'code' AS code, payload->>'title' AS title FROM domain_event WHERE event_type = 'motor.fault_code_raised.v1'`);
    expect(event).toEqual({ code: 'P999', title: 'Device fault P999' });
  });

  it('the old threshold settings are refused: there is nothing left to read them', async () => {
    const admin: RequestScope = { tenantId: TENANT, userId: 'u-admin', roles: ['super admin'], isPlatformRole: false };
    const parameters = new ParameterService(ds);
    for (const name of ['pcode_low_voltage', 'pcode_high_voltage', 'pcode_overheat_temp',
      'pcode_dry_run_ratio', 'pcode_overload_ratio', 'pcode_locked_rotor_ratio']) {
      const attempt = parameters.set(admin, { scope: 'client', name, value: 200 } as never);
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(parameters.set(admin, { scope: 'client', name, value: 200 } as never)).rejects.toThrow(/unknown_parameter/);
    }
  });
});
