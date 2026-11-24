import { DataSource } from 'typeorm';
import { recordMotorFaults } from '../src/motor-ingest/motor-fault-codes';
import { DEFAULT_THRESHOLDS, FaultSample, THRESHOLD_PARAMETERS, deviceFaults } from '../src/motor-ingest/p-code-rules';
import { operationalParameter } from '../src/parameters/parameter-catalog';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorPCodeThresholds1766200000000';
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000);

jest.setTimeout(60_000);

/**
 * The P-code lines are configurable (Motor Monitor integration spec, 24 Nov 2026: "all
 * thresholds configurable"): each is an operational parameter, set for an account, a
 * site, a class or one machine, and the spec's own value where none is.
 */
describe('P-code thresholds in the rules', () => {
  const supply = (volts: number, n = 5): FaultSample[] =>
    Array.from({ length: n }, (_, i) => ({ at: at(i), voltage: volts, current: 4.7, temperature: 40 }));
  const last = (r: ReturnType<typeof deviceFaults>) => [...r[r.length - 1].active].sort().join(',');

  it('unset, every line is the spec\'s: 195 V is not low', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      lowVoltage: 190, highVoltage: 250, overheatTemp: 70, dryRunRatio: 0.8, overloadRatio: 1.2, lockedRotorRatio: 3,
    });
    expect(last(deviceFaults(supply(195), 5.5))).toBe('');
  });

  it('a raised low-voltage line makes 195 V low, and a lowered high-voltage line makes 245 V high', () => {
    expect(last(deviceFaults(supply(195), 5.5, { ...DEFAULT_THRESHOLDS, lowVoltage: 200 }))).toBe('P101');
    expect(last(deviceFaults(supply(245), 5.5, { ...DEFAULT_THRESHOLDS, highVoltage: 240 }))).toBe('P102');
  });

  it('every threshold is a declared parameter, so the API accepts it and nothing reads a name nobody can set', () => {
    for (const name of Object.values(THRESHOLD_PARAMETERS)) expect(operationalParameter(name)).toBeDefined();
  });
});

describeDb('P-code thresholds from the account\'s parameters', () => {
  const TENANT = 'motors';
  let owner: DataSource;
  let ds: DataSource;
  let equipmentId: string;

  const setParam = (scope: 'client' | 'equipment', name: string, value: number) => owner.query(
    `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, null, '2026-01-01', 'test')`,
    [TENANT, scope, scope === 'client' ? null : equipmentId, name, JSON.stringify(value)]);
  /** Ten running seconds at `volts`, placed in time as the motor job leaves them. */
  const readings = (volts: number) => owner.query(
    `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm,
                                       batch_id, received_at, reading_at, time_basis)
     SELECT 'MOTOR_001', i, i, $1, 4.7, 0.8, 40, 2800, 'b', now(), $2::timestamptz + make_interval(secs => i), 'approximate'
       FROM generate_series(0, 9) i`, [volts, at(0)]);
  const opened = async () => {
    await recordMotorFaults(ds, { tenantId: TENANT, externalId: 'PUMP-1', deviceId: 'MOTOR_001', from: at(0), to: at(9) });
    return (await owner.query(`SELECT code FROM device_dtc_episode WHERE protocol = 'pcode' ORDER BY code`)).map((r: { code: string }) => r.code);
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE motor_sensor_records, device_inventory, tenant_parameter, device_dtc_episode, fault_code_type_grant CASCADE`);
    await owner.query(`DELETE FROM equipment_profile`);
    [{ id: equipmentId }] = await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness)
       VALUES ($1, 'ta-2.0', 'PUMP-1', 'basic', '{}') RETURNING id`, [TENANT]);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', $1, 'assigned', 'PUMP-1')`, [TENANT]);
    await owner.query(`INSERT INTO fault_code_type_grant (tenant_id, code_type, granted_by) VALUES ($1, 'motor-pump', 'test')`, [TENANT]);
  });

  it('with nothing set, 195 V raises nothing', async () => {
    await readings(195);
    expect(await opened()).toEqual([]);
  });

  it('the account\'s own low-voltage line of 200 V makes 195 V a P101', async () => {
    await setParam('client', 'pcode_low_voltage', 200);
    await readings(195);
    expect(await opened()).toEqual(['P101']);
  });

  it('a machine\'s own line beats the account\'s', async () => {
    await setParam('client', 'pcode_low_voltage', 200);
    await setParam('equipment', 'pcode_low_voltage', 180);
    await readings(195);
    expect(await opened()).toEqual([]);
  });

  it('the database refuses a threshold of zero or below: it would silence its code, not tune it', async () => {
    for (const value of [0, -1]) {
      await expect(setParam('client', 'pcode_dry_run_ratio', value)).rejects.toThrow(/ck_tenant_parameter_value/);
    }
    await expect(setParam('client', 'pcode_dry_run_ratio', 0.6)).resolves.toBeDefined();
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    // Accepted without the arm. Tried in a transaction that is rolled back: the table is
    // append-only, so a row written here could not be removed, and re-applying the
    // constraint over it would fail.
    const qr = owner.createQueryRunner();
    await qr.startTransaction();
    try {
      await expect(qr.query(
        `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ($1, 'client', null, 'pcode_overload_ratio', '0'::jsonb, null, '2026-01-01', 'test')`, [TENANT])).resolves.toBeDefined();
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
    await owner.runMigrations({ transaction: 'all' });
    await expect(setParam('client', 'pcode_overload_ratio', 0)).rejects.toThrow(/ck_tenant_parameter_value/);
  });
});
