import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertService } from '../src/alert/services/alert.service';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { batches, simulate } from '../scripts/motor-logger-sim';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Threshold rules judged as a motor logger's readings land (Crompton POC T3: a dry run
 * or an overload is a call to make within the minute, not at the end of a twelve-hour
 * shift). Same rules, same AlertService as the shift close; one standing alert per rule
 * per machine whichever path raises it.
 */
describeDb('motor loggers: alerts as readings land', () => {
  let owner: DataSource;
  let ds: DataSource;
  let alerts: AlertService;
  let motors: MotorIngestService;

  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const END = Math.floor(NOW.getTime() / 1000);
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

  /** The receiver's insert, as the motor specs store it. */
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
  const events = () => owner.query(`SELECT rule_name AS "rule", shift_local_date::text AS "day", state FROM alert_event ORDER BY fired_at`);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-11-01'::date)`);
    ds = await createAppDataSource();
    alerts = new AlertService(ds);
    motors = new MotorIngestService(ds, alerts);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['alert_event', 'alert_rule', 'equipment_profile', 'client_equipment_class']) await owner.query(`DELETE FROM "${t}"`);
    await owner.query(`TRUNCATE "motor_sensor_records", "motor_upload_log", "telemetry_reading", "device_inventory", "tenant_parameter" CASCADE`);
    await owner.query(`DELETE FROM tenant WHERE tenant_id = 'acme'`);
    await owner.query(`INSERT INTO tenant (tenant_id, name, status) VALUES ('acme', 'Acme', 'active')`);
    await owner.getRepository(ClientEquipmentClass).save({
      tenantId: 'acme', slug: 'pump-1ph', name: 'Pump', description: null, category: 'pump',
      expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'pump-1ph', templateVersion: 1,
      templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
    });
    const { id } = await new EquipmentService(ds).create(acme, { code: 'PUMP-1', name: 'Pump 1', equipmentClassSlug: 'pump-1ph' });
    const parameters = new ParameterService(ds);
    for (const [name, value] of [['rated_current', 5.5], ['rated_voltage', 220]] as const) {
      await parameters.set(acme, { scope: 'equipment', scopeRef: id, name, value, effectiveFrom: new Date('2026-01-01') });
    }
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'acme', 'assigned', 'PUMP-1')`);
    await alerts.createRule(acme, {
      slug: 'overload', name: 'Overload', trigger: 'signal-threshold',
      params: { signal: 'motor_current', rating: 'rated_current', max: 1.2 }, appliesTo: 'account',
    });
  });

  it('an overload raises its alert in the pass that stores it, dated in the account\'s own time zone', async () => {
    await store(simulate('overload', 20 * 60, END, END - 21 * 60));
    const summary = await motors.processPending(NOW);
    expect(summary.alerts).toBe(1);
    // 12:00 UTC is 17:30 in Asia/Kolkata, the account's default zone: still 9 Nov.
    expect(await events()).toEqual([{ rule: 'Overload', day: '2026-11-09', state: 'open' }]);
  });

  it('the next pass, still overloaded, does not raise it again: one standing alert per rule', async () => {
    await store(simulate('overload', 20 * 60, END - 120, END - 21 * 60));
    await motors.processPending(new Date(NOW.getTime() - 120_000));
    await store(simulate('overload', 120, END, END - 21 * 60));
    const second = await motors.processPending(NOW);
    expect(second.alerts ?? 0).toBe(0);
    expect(await events()).toHaveLength(1);
  });

  it('a healthy motor raises nothing', async () => {
    await store(simulate('normal', 20 * 60, END, END - 21 * 60));
    expect((await motors.processPending(NOW)).alerts ?? 0).toBe(0);
    expect(await events()).toEqual([]);
  });

  it('only threshold rules are judged live; a whole-shift rule waits for the shift close', async () => {
    await alerts.createRule(acme, { slug: 'silent', name: 'Silent', trigger: 'no-telemetry', params: {}, appliesTo: 'account' });
    await store(simulate('normal', 20 * 60, END, END - 21 * 60));
    await motors.processPending(NOW);
    expect(await events()).toEqual([]);
  });

  it('without the alert service (the ingest alone), telemetry is written and nothing is judged', async () => {
    await store(simulate('overload', 20 * 60, END, END - 21 * 60));
    const summary = await new MotorIngestService(ds).processPending(NOW);
    expect(summary.readings).toBe(1200);
    expect(summary.alerts).toBeUndefined();
    expect(await events()).toEqual([]);
  });
});
