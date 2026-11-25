import { DataSource } from 'typeorm';
import { EXPIRED_ERROR, OutboxConsumer } from '../src/events/outbox-consumer';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { OutgoingMail } from '../src/mail/mail.service';
import { MotorFaultNotifyHandler, MotorOfflineNotifyHandler } from '../src/motor-ingest/motor-alert-notify.handler';
import { recordMotorFaults } from '../src/motor-ingest/motor-fault-codes';
import { MotorIngestService } from '../src/motor-ingest/motor-ingest.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'MotorAlertEvents1766300000000';
const MIN = 60_000;

/** A mail transport that records what it was given. */
class FakeMail {
  readonly sent: OutgoingMail[] = [];
  publicUrl() { return 'https://console.example.test'; }
  async send(mail: OutgoingMail): Promise<boolean> { this.sent.push(mail); return true; }
}

jest.setTimeout(60_000);

/**
 * The pump logger's email alerts (Motor Monitor integration spec, 24 Nov 2026: "Alerts
 * … when P101, P102, P207, P401, P702 or P708 becomes active, or a device goes
 * offline"). The mail transport is faked; who is told comes from the real users, roles,
 * sites and resolver, and the outbox and the database rules that keep one thing from
 * being reported twice are the real ones.
 */
describeDb('motor email alerts', () => {
  let owner: DataSource;
  let ds: DataSource;
  let mail: FakeMail;
  let consumer: OutboxConsumer;
  let motors: MotorIngestService;
  const ids: Record<string, string> = {};
  const NOW = new Date('2026-11-24T10:00:00Z');
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    motors = new MotorIngestService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * acme: pump M1 at NORTH (logger MOTOR_001), pump M2 at SOUTH.
   *  owen  operator (no action.assign)          → never
   *  ada   admin, whole account                 → told about M1
   *  sam   site manager for SOUTH only          → not about M1
   *  nina  site manager for NORTH               → told about M1
   *  sue   admin, suspended                     → never
   * globex: gina admin                          → never
   */
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "notification_delivery", "domain_event", "device_dtc_episode", "motor_sensor_records",
      "motor_upload_log", "device_inventory", "fault_code_type_grant", "user_plant_access", "app_user", "tenant_role",
      "equipment_profile", "plant" CASCADE`);
    await owner.query(`INSERT INTO tenant (tenant_id, name, time_zone) VALUES ('acme', 'Acme', 'Asia/Kolkata') ON CONFLICT DO NOTHING`);
    const [north] = await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme','NORTH','North farm','active') RETURNING id`);
    const [south] = await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme','SOUTH','South farm','active') RETURNING id`);
    for (const [ext, plant] of [['M1', north.id], ['M2', south.id]]) {
      await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
        VALUES ('acme','ta-2.0',$1,$2,'client','active','basic','{}'::jsonb,$3)`, [ext, `Pump ${ext}`, plant]);
    }
    const role = (tenant: string, slug: string, caps: string[], shape: string) => owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES ($1,$2,$2,$3::text[],$4)`, [tenant, slug, caps, shape]);
    await role('acme', 'operator', ['device.read'], 'tenant');
    await role('acme', 'admin', ['device.read', 'action.assign'], 'tenant');
    await role('acme', 'site-manager', ['device.read', 'action.assign'], 'plant');
    await role('globex', 'admin', ['device.read', 'action.assign'], 'tenant');
    const user = async (key: string, tenant: string, slug: string, status = 'active') => {
      const [u] = await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenant, `${key}@${tenant}.test`, key, slug, status]);
      ids[key] = u.id;
    };
    await user('owen', 'acme', 'operator');
    await user('ada', 'acme', 'admin');
    await user('sam', 'acme', 'site-manager');
    await user('nina', 'acme', 'site-manager');
    await user('sue', 'acme', 'admin', 'suspended');
    await user('gina', 'globex', 'admin');
    await owner.query(`INSERT INTO user_plant_access (tenant_id, user_id, plant_id) VALUES ('acme',$1,$2), ('acme',$3,$4)`,
      [ids.sam, south.id, ids.nina, north.id]);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'acme', 'assigned', 'M1')`);
    await owner.query(`INSERT INTO fault_code_type_grant (tenant_id, code_type, granted_by) VALUES ('acme', 'motor-pump', 'test')`);

    mail = new FakeMail();
    const resolver = new ScopeResolverService(ds);
    consumer = new OutboxConsumer(ds, [new MotorFaultNotifyHandler(mail as never, resolver), new MotorOfflineNotifyHandler(mail as never, resolver)]);
  });

  const to = () => mail.sent.map((s) => s.to).sort();
  const events = (type: string) => owner.query(
    `SELECT subject, delivery_state, last_error FROM domain_event WHERE event_type = $1 ORDER BY occurred_at`, [type]);

  describe('a P-code becomes active', () => {
    let seq = 0;
    /**
     * `n` seconds at `volts` from `start`, placed in time as the motor job leaves them,
     * each carrying the device's P101 while the supply is under its 190 V line.
     */
    const seconds = async (start: Date, n: number, volts: number) => {
      await owner.query(
        `INSERT INTO motor_sensor_records (device_id, seq, device_ts, voltage_v, current_a, power_factor, temperature_c, rpm,
                                           batch_id, received_at, reading_at, time_basis, device_faults)
         SELECT 'MOTOR_001', $1 + i, $1 + i, $2, 0, 0, 40, 0, 'b', now(), $3::timestamptz + make_interval(secs => i), 'approximate',
                CASE WHEN $2::numeric < 190 THEN ARRAY['P101'] ELSE '{}'::text[] END
           FROM generate_series(0, $4 - 1) i`, [seq, volts, start, n]);
      seq += n;
      await recordMotorFaults(ds, { tenantId: 'acme', externalId: 'M1', deviceId: 'MOTOR_001', from: start, to: new Date(start.getTime() + n * 1000) });
    };
    beforeEach(() => { seq = 0; });

    it('emails everyone who can assign work on the pump, once, and nobody else', async () => {
      await seconds(ago(5), 10, 180);
      expect(await consumer.pass(NOW)).toEqual({ delivered: 1, retried: 0, failed: 0 });
      // ada (whole account) and nina (North). Not owen (cannot assign), sam (South only),
      // sue (suspended) or gina (another account).
      expect(to()).toEqual(['ada@acme.test', 'nina@acme.test']);
      expect(mail.sent[0].subject).toBe('P101 Low voltage on Pump M1');
      expect(mail.sent[0].text).toContain('became active on Pump M1 at North farm at 24 Nov 2026, 15:25 (Asia/Kolkata)');
      // The code holds for the next pass too: that is the same episode, not a new email.
      await seconds(ago(4), 10, 180);
      expect(await consumer.pass(NOW)).toEqual({ delivered: 0, retried: 0, failed: 0 });
      expect(mail.sent).toHaveLength(2);
    });

    it('a code back within 30 minutes of clearing opens an episode but no second email; after that, it emails again', async () => {
      await seconds(ago(90), 10, 180);  // P101 opens
      await seconds(ago(89), 5, 230);   // and clears
      await seconds(ago(80), 10, 180);  // back 9 minutes later: quiet
      await seconds(ago(79), 5, 230);
      await seconds(ago(20), 10, 180);  // back an hour later: news
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM device_dtc_episode WHERE protocol = 'pcode' AND code = 'P101'`);
      expect(n).toBe(3);
      expect(await events('motor.fault_code_raised.v1')).toHaveLength(2);
    });

    it('a backlog from last week opens its episodes but emails nobody: the outbox lets it expire', async () => {
      await seconds(new Date(NOW.getTime() - 7 * 24 * 60 * MIN), 10, 180);
      expect(await consumer.pass(NOW)).toEqual({ delivered: 0, retried: 0, failed: 1 });
      expect(mail.sent).toEqual([]);
      expect((await events('motor.fault_code_raised.v1'))[0]).toMatchObject({ delivery_state: 'failed', last_error: EXPIRED_ERROR });
    });
  });

  describe('a logger goes offline', () => {
    const upload = (at: Date, deviceId = 'MOTOR_001') => owner.query(
      `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, received_at, processed_at)
       VALUES ($1, 'b', 1, 50, 50, 50, $2, $2)`, [deviceId, at]);

    it('silent for 15 minutes: one alert, however many passes see it, emailed to the same people', async () => {
      await upload(ago(15));
      const passes = await Promise.allSettled([motors.processPending(NOW), motors.processPending(NOW)]);
      expect(passes.map((p) => p.status)).toEqual(['fulfilled', 'fulfilled']);
      await motors.processPending(new Date(NOW.getTime() + 20 * MIN));
      expect(await events('motor.logger_offline.v1')).toEqual([
        { subject: `MOTOR_001@${ago(15).toISOString()}`, delivery_state: 'pending', last_error: null },
      ]);
      expect(await consumer.pass(NOW)).toEqual({ delivered: 1, retried: 0, failed: 0 });
      expect(to()).toEqual(['ada@acme.test', 'nina@acme.test']);
      expect(mail.sent[0].subject).toBe('Logger offline on Pump M1');
      expect(mail.sent[0].text).toContain('MOTOR_001 on Pump M1 at North farm has not uploaded since 24 Nov 2026, 15:15 (Asia/Kolkata)');
    });

    it('back before the email went out: nothing is sent', async () => {
      await upload(ago(15));
      await motors.processPending(NOW);
      await upload(ago(1));
      expect(await consumer.pass(NOW)).toEqual({ delivered: 1, retried: 0, failed: 0 });
      expect(mail.sent).toEqual([]);
    });

    it('the next silence after it came back is a new alert', async () => {
      await upload(ago(60));
      await motors.processPending(ago(45));
      await upload(ago(30));
      await motors.processPending(NOW);
      expect((await events('motor.logger_offline.v1')).map((e: { subject: string }) => e.subject)).toEqual([
        `MOTOR_001@${ago(60).toISOString()}`, `MOTOR_001@${ago(30).toISOString()}`,
      ]);
    });

    it('not yet offline, silent for over a day, or not mapped to a machine: nothing', async () => {
      await upload(ago(8));
      await upload(new Date(NOW.getTime() - 26 * 60 * MIN), 'MOTOR_OLD');
      await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state) VALUES ('MOTOR_OLD', 'acme', 'assigned'), ('MOTOR_LOOSE', 'acme', 'assigned')`);
      await upload(ago(15), 'MOTOR_LOOSE');
      await motors.processPending(NOW);
      expect(await events('motor.logger_offline.v1')).toEqual([]);
    });
  });

  it('the database refuses a second event for the same silence, whoever writes it', async () => {
    const insert = () => owner.query(
      `INSERT INTO domain_event (event_type, tenant_id, subject, payload, occurred_at)
       VALUES ('motor.logger_offline.v1', 'acme', 'MOTOR_001@x', '{}'::jsonb, now())`);
    await insert();
    await expect(insert()).rejects.toThrow(/uq_domain_event_motor_alert/);
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    const has = async () => (await owner.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_domain_event_motor_alert'`)).length;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await has()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await has()).toBe(1);
  });
});
