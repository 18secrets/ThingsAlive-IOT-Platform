import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertEvent } from '../src/alert/entities/alert-event.entity';
import { MachineHealthService } from '../src/machine-health/machine-health.controller';
import { snapshotMachines } from '../src/vani/vani-snapshot';
import { queueVaniCalls } from '../src/vani/vani-queue';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Where a machine's health score comes from (D63), read from the database the way the
 * endpoint and Vani read it.
 *
 * The arithmetic is `health-score.spec.ts`. This is about the inputs: that a resolved
 * alert, a replayed or week-old prediction and another account's rows are not counted;
 * that a machine with no device or no logger reading is unknown rather than 100; that
 * a caller cannot read a machine outside their own; and that Vani gets the number only
 * when there is one.
 */
describeDb('machine health: read from the platform', () => {
  let owner: DataSource;
  let app: DataSource;
  let health: MachineHealthService;

  const SRC = 'ta-2.0';
  const NOW = new Date();
  const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const boss: RequestScope = { tenantId: 'usa-test', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const operator: RequestScope = { ...boss, userId: 'u-op', roles: ['operator'], equipmentIds: ['DG-02'] };

  const machine = (tenant: string, ext: string) => owner.query(
    `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
       VALUES ($1, $2, $3, $3, 'client', 'active', 'basic', '{}'::jsonb)`, [tenant, SRC, ext]);
  const mapDevice = (tenant: string, imei: string, ext: string) => owner.query(
    `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at)
       VALUES ($1, $2, 'assigned', $3, $4)`, [imei, tenant, ext, ago(100)]);
  const link = (tenant: string, imei: string, ext: string, state: string, endedHoursAgo = 1) => owner.query(
    `INSERT INTO device_link_health
       (tenant_id, imei, source_system, external_id, local_date, window_start, window_end, state, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'd')`,
    [tenant, imei, SRC, ext, ago(endedHoursAgo).toISOString().slice(0, 10), ago(endedHoursAgo + 8), ago(endedHoursAgo), state]);
  const alert = (tenant: string, ext: string, severity: string, state = 'open', name = `${severity} alert`) => owner.query(
    `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state,
                             fired_at, resolution_note)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 's', '{}'::jsonb, $6, now(), $7) RETURNING id`,
    [tenant, name, SRC, ext, severity, state, state === 'resolved' ? 'Fixed' : null]);
  const prediction = (tenant: string, ext: string, slug: string, risk: number, at: Date, source = 'live', confidence = 'full') =>
    owner.query(
      `INSERT INTO prediction (tenant_id, source_system, external_id, client_scenario_slug, severity, risk_score, confidence,
                               window_days, occurred_at, source)
         VALUES ($1, $2, $3, $4, 'medium', $5, $6, 7, $7, $8)`,
      [tenant, SRC, ext, slug, risk, confidence, at, source]);

  const scoreOf = (ext: string, scope = boss) => health.forMachine(scope, SRC, ext);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    health = new MachineHealthService(app);
    for (const t of ['usa-test', 'globex']) await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1)`, [t]);
    for (const ext of ['DG-01', 'DG-02', 'DG-03']) await machine('usa-test', ext);
    await machine('globex', 'DG-01');
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['vani_call', 'vani_machine_link', 'vani_account_link', 'alert_event', 'prediction',
      'device_link_health', 'device_inventory']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
  });

  it('has no score for a machine with no device mapped, even with a logger reading', async () => {
    await link('usa-test', 'L1', 'DG-01', 'healthy');
    expect(await scoreOf('DG-01')).toMatchObject({ score: null, band: 'unknown', unknownReason: 'not_onboarded' });
  });

  it('has no score for a mapped machine whose logger was last measured two days ago', async () => {
    await mapDevice('usa-test', 'L1', 'DG-01');
    await link('usa-test', 'L1', 'DG-01', 'healthy', 49);
    expect(await scoreOf('DG-01')).toMatchObject({ score: null, unknownReason: 'logger_stale' });
  });

  it('counts unresolved alerts and this week\'s live predictions, and nothing else', async () => {
    await mapDevice('usa-test', 'L1', 'DG-01');
    await link('usa-test', 'L1', 'DG-01', 'healthy');
    await alert('usa-test', 'DG-01', 'high', 'acknowledged', 'Coolant hot');
    await alert('usa-test', 'DG-01', 'critical', 'resolved', 'Fixed yesterday');
    await alert('globex', 'DG-01', 'critical', 'open', 'Another account');
    await prediction('usa-test', 'DG-01', 'bearing-wear', 50, ago(30));  // older score of the same scenario
    await prediction('usa-test', 'DG-01', 'bearing-wear', 20, ago(2));   // the latest: this one counts
    await prediction('usa-test', 'DG-01', 'fuel-theft', 95, ago(2), 'replayed');
    await prediction('usa-test', 'DG-01', 'coolant-drift', 99, ago(24 * 8));

    const h = await scoreOf('DG-01');
    expect(h.deductions).toEqual([
      { kind: 'alert', points: 25, about: 'Coolant hot' },
      { kind: 'prediction', points: 6, about: 'bearing-wear' },
    ]);
    expect(h).toMatchObject({ score: 69, band: 'watch' });
  });

  it('refuses a machine outside the caller\'s own, as if it did not exist', async () => {
    await expect(scoreOf('DG-01', operator)).rejects.toThrow(NotFoundException);
    await expect(scoreOf('DG-99')).rejects.toThrow(NotFoundException);
    await expect(health.forMachine(boss, SRC, 'DG-01', 'globex')).rejects.toThrow(/Only Things Alive staff/);
  });

  describe('what Vani gets', () => {
    const linkVani = async () => {
      await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
      for (const [ext, id] of [['DG-01', 'dg-01'], ['DG-02', 'dg-02']]) {
        await owner.query(
          `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
             VALUES ('usa-test', $1, $2, $3, $2)`, [SRC, ext, id]);
      }
      await mapDevice('usa-test', 'L1', 'DG-01');
      await link('usa-test', 'L1', 'DG-01', 'healthy');
    };

    it('puts health_score on a machine it can score, and leaves it off one it cannot', async () => {
      await linkVani();
      await alert('usa-test', 'DG-01', 'high');
      const machines = await withTenantId(app, 'usa-test', (m) => snapshotMachines(m, 'usa-test', false, NOW));
      expect(machines.find((x) => x.machine_id === 'dg-01')).toMatchObject({ health_score: 75 });
      expect(machines.find((x) => x.machine_id === 'dg-02')).not.toHaveProperty('health_score');
    });

    it('says the score on the call, with the alert being called about in it', async () => {
      await linkVani();
      const [{ id }] = await alert('usa-test', 'DG-01', 'critical', 'open', 'Oil pressure lost');
      const a = await owner.getRepository(AlertEvent).findOneByOrFail({ id });
      await withTenantId(app, 'usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]));
      const [row] = await owner.query(`SELECT request FROM vani_call WHERE alert_event_id = $1`, [id]);
      expect(row.request.context.health_card).toBe('Health score 60 of 100: one open alert.');
    });

    it('leaves the card off a call about a machine it cannot score', async () => {
      await linkVani();
      const [{ id }] = await alert('usa-test', 'DG-02', 'critical');
      const a = await owner.getRepository(AlertEvent).findOneByOrFail({ id });
      await withTenantId(app, 'usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]));
      const [row] = await owner.query(`SELECT request FROM vani_call WHERE alert_event_id = $1`, [id]);
      expect(row.request.context).not.toHaveProperty('health_card');
    });
  });
});
