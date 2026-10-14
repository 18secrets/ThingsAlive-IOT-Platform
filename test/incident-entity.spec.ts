import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { IncidentEscalationScheduler } from '../src/incident/incident-escalation.scheduler';
import { AlertEvent } from '../src/alert/entities/alert-event.entity';
import { absorbAlerts } from '../src/incident/incident-absorb';
import { IncidentRecordService } from '../src/incident/incident-record.service';
import { IncidentService } from '../src/incident/incident.service';
import { createApp } from '../src/main';
import { withTenantSession } from '../src/scope/tenant-session';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'IncidentEntity1760200000000';
const SRC = 'iot-platform-1';
const MIN = 60_000;

/**
 * The incident entity (phase 2): alerts gathered per machine into something with an
 * owner, a clock and an escalation path — end to end, from the evaluator firing an
 * alert to the incident resolved and the next alert opening a fresh one.
 */
describeDb('incident entity, end to end', () => {
  let owner: DataSource;
  let app: INestApplication;
  let alerts: AlertService;
  let records: IncidentRecordService;
  let view: IncidentService;
  let work: WorkOrderService;
  let scheduler: IncidentEscalationScheduler;
  let operatorId: string;
  let outsiderId: string;

  const boss: RequestScope = { tenantId: 'acme', userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const tech: RequestScope = { tenantId: 'acme', userId: 'u-tech', roles: ['operational'], isPlatformRole: false };
  const elsewhere: RequestScope = { ...tech, equipmentIds: ['DG-OTHER'] };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-g', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-incident';
    process.env.AUTH_JWT_ISSUER = 'things-alive-incident-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    alerts = app.get(AlertService);
    records = app.get(IncidentRecordService);
    view = app.get(IncidentService);
    work = app.get(WorkOrderService);
    scheduler = app.get(IncidentEscalationScheduler);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "incident_event", "incident_alert", "incident", "incident_sla_policy", "work_order", "alert_event",
        "alert_rule", "equipment_profile", "domain_event" CASCADE`,
    );
    await owner.query(`DELETE FROM app_user WHERE email LIKE '%@incident.test'`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
         VALUES ('acme', $1, 'DG-1', 'standard', '{}'::jsonb, 'u')`, [SRC],
    );
    [{ id: operatorId }] = await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', 'op@incident.test', 'Op', 'operational', 'active') RETURNING id`,
    );
    [{ id: outsiderId }] = await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('globex', 'g@incident.test', 'G', 'operational', 'active') RETURNING id`,
    );
    for (const [slug, severity] of [['hot', 'high'], ['very-hot', 'critical']]) {
      await owner.query(
        `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
           VALUES ('acme', $1, $1, 'prediction-severity', '{"atLeast": "high"}'::jsonb, 'account', $2, true)`, [slug, severity],
      );
    }
  });

  const setPolicy = (severity: Severity, ack: number, resolve: number) => records.setPolicy(boss, severity, ack, resolve);
  /** One shift's evaluation of every rule against a critical prediction: both rules fire. */
  const fire = (at = new Date()) => alerts.evaluateWindow({
    tenantId: 'acme', sourceSystem: SRC, externalId: 'DG-1', shiftLocalDate: at.toISOString().slice(0, 10),
    windowStart: new Date(at.getTime() - 60 * MIN), windowEnd: at, readings: [],
    predictions: [{ clientScenarioSlug: 's', severity: Severity.Critical, riskScore: 95, predictionId: '11111111-1111-1111-1111-111111111111', confidence: 'full' }],
  });
  const live = async () => (await records.list(boss, { status: 'live' }));

  it('an alert from the evaluator opens one incident per machine, gathers the next, and a worse one tightens the clock', async () => {
    await setPolicy(Severity.High, 30, 240);
    await setPolicy(Severity.Critical, 10, 60);
    const fired = await fire();
    expect(fired).toHaveLength(2);
    const [incident] = await live();
    expect(incident).toMatchObject({ severity: 'critical', status: 'open', escalationLevel: 0 });
    const opened = new Date(incident.openedAt).getTime();
    // Critical's promise, measured from when the machine first got into trouble.
    expect(new Date(incident.sla.acknowledge.dueAt!).getTime()).toBe(opened + 10 * MIN);
    expect(new Date(incident.sla.resolve.dueAt!).getTime()).toBe(opened + 60 * MIN);
    const detail = await records.get(boss, incident.id);
    expect(detail.alerts).toHaveLength(2);
    expect(detail.timeline.map((e) => e.kind).sort()).toEqual(['alert_linked', 'opened', 'severity_raised'].sort());
  });

  it('two different alerts arriving at once on one machine still make one incident', async () => {
    // Two rules' alerts, already raised, gathered in two concurrent transactions — the
    // race `uq_incident_live_per_machine` exists for. (Two evaluations of the *same* rule
    // are refused earlier, by the alert table's own `uq_alert_event_standing`.)
    const ruleIds: { id: string }[] = await owner.query(`SELECT id FROM alert_rule ORDER BY slug`);
    const raised: AlertEvent[] = [];
    for (const [i, { id }] of ruleIds.entries()) {
      const [row] = await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state)
           VALUES ('acme', $1, 'r', $2, 'DG-1', $3, 's', '{}'::jsonb, 'open') RETURNING *`, [id, SRC, i ? 'critical' : 'high'],
      );
      raised.push({ ...row, firedAt: new Date(row.fired_at), sourceSystem: SRC, externalId: 'DG-1', severity: row.severity } as AlertEvent);
    }
    const ds = app.get(DataSource);
    const results = await Promise.allSettled(raised.map((a) => withTenantSession(ds, boss, (m) => absorbAlerts(m, 'acme', [a]))));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT count(*)::int AS n FROM incident WHERE status <> 'resolved'`)).toEqual([{ n: 1 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM incident_alert`)).toEqual([{ n: 2 }]);
  });

  it('no policy is no clock — never a default somebody did not promise', async () => {
    await fire();
    const [incident] = await live();
    expect(incident.sla).toEqual({ acknowledge: { dueAt: null, state: 'no_policy' }, resolve: { dueAt: null, state: 'no_policy' } });
  });

  it('the lifecycle: acknowledge, assign, raise work, refuse to resolve over open work, finish it, resolve', async () => {
    await setPolicy(Severity.Critical, 10, 60);
    await fire();
    const [incident] = await live();

    const acked = await records.acknowledge(tech, incident.id);
    expect(acked.status).toBe('acknowledged');
    expect(acked.sla.acknowledge.state).toBe('met');
    expect(await owner.query(`SELECT DISTINCT state FROM alert_event`)).toEqual([{ state: 'acknowledged' }]);
    expect((await records.acknowledge(tech, incident.id)).acknowledgedAt).toBe(acked.acknowledgedAt);

    expect((await records.assign(boss, incident.id, operatorId)).ownerUserId).toBe(operatorId);
    await expect(records.assign(boss, incident.id, outsiderId)).rejects.toThrow(/No active user/);
    await expect(records.assign(tech, incident.id, operatorId)).rejects.toThrow(/may not assign/);

    const job = await records.raiseWork(boss, incident.id, { title: 'Check the radiator', priority: 'urgent' });
    const critical = (await owner.query(`SELECT id FROM alert_event WHERE severity = 'critical'`))[0].id;
    expect(job.alertId).toBe(critical);
    expect((await records.get(boss, incident.id)).workOrders.map((w) => w.title)).toEqual(['Check the radiator']);

    await expect(records.resolve(tech, incident.id, 'Fixed')).rejects.toThrow(/"Check the radiator"/);
    await expect(records.resolve(tech, incident.id, '  ')).rejects.toThrow(/note is required/);
    await work.act(boss, job.id, 'start', null);
    await work.act(boss, job.id, 'complete', 'Radiator cleaned');

    const resolved = await records.resolve(tech, incident.id, 'Radiator was blocked; cleaned');
    expect(resolved).toMatchObject({ status: 'resolved', resolutionNote: 'Radiator was blocked; cleaned' });
    expect(await owner.query(`SELECT DISTINCT state, resolution_note FROM alert_event`))
      .toEqual([{ state: 'resolved', resolution_note: 'Radiator was blocked; cleaned' }]);
    expect((await view.list(boss)).incidents).toEqual([]);

    // The fault coming back is a new incident, not the old one reopened.
    await fire();
    const next = await live();
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(incident.id);
  });

  it('escalates each overdue clock once, onto the timeline and into the outbox', async () => {
    await setPolicy(Severity.Critical, 10, 60);
    await fire();
    const [incident] = await live();
    const opened = new Date(incident.openedAt).getTime();

    await scheduler.tick(new Date(opened + 5 * MIN));
    expect((await live())[0].escalationLevel).toBe(0);
    await scheduler.tick(new Date(opened + 11 * MIN));
    expect((await records.list(boss, { status: 'live' }, new Date(opened + 11 * MIN)))[0])
      .toMatchObject({ escalationLevel: 1, sla: { acknowledge: { state: 'breached' } } });
    await scheduler.tick(new Date(opened + 12 * MIN));
    await scheduler.tick(new Date(opened + 61 * MIN));
    expect((await live())[0].escalationLevel).toBe(2);
    const outbox = await owner.query(
      `SELECT event_type, subject, payload->>'reason' AS reason FROM domain_event WHERE event_type = 'incident.escalated.v1' ORDER BY occurred_at`,
    );
    expect(outbox).toEqual([
      { event_type: 'incident.escalated.v1', subject: incident.id, reason: 'acknowledgement_overdue' },
      { event_type: 'incident.escalated.v1', subject: incident.id, reason: 'resolution_overdue' },
    ]);
  });

  it('the view carries each machine\'s live incident record', async () => {
    await fire();
    const [row] = (await view.list(boss)).incidents;
    expect(row.incident).toMatchObject({ status: 'open', severity: 'critical', machine: { externalId: 'DG-1' } });
  });

  it('isolation: another account sees nothing; an operator off this machine gets a 404', async () => {
    await fire();
    const [incident] = await live();
    expect(await records.list(globex)).toEqual([]);
    expect(await withTenantSession(app.get(DataSource), globex, (m) => m.query(`SELECT count(*)::int AS n FROM incident`)))
      .toEqual([{ n: 0 }]);
    await expect(records.get(elsewhere, incident.id)).rejects.toThrow(/No such incident/);
    await expect(records.acknowledge(elsewhere, incident.id)).rejects.toThrow(/No such incident/);
  });

  it('the database holds the rules: one live per machine, resolved needs its note, the timeline is append-only', async () => {
    await fire();
    const [incident] = await live();
    await expect(owner.query(
      `INSERT INTO incident (tenant_id, source_system, external_id, severity, opened_at) VALUES ('acme', $1, 'DG-1', 'low', now())`, [SRC],
    )).rejects.toThrow(/uq_incident_live_per_machine/);
    await expect(owner.query(
      `UPDATE incident SET status = 'resolved', acknowledged_at = now(), resolved_at = now() WHERE id = $1`, [incident.id],
    )).rejects.toThrow(/ck_incident_resolved/);
    await expect(owner.query(`UPDATE incident_event SET actor = 'x'`)).rejects.toThrow(/incident_event_append_only/);
    // The demo reset's exemption does not reach a real account, even with its flag set.
    await expect(owner.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.seed_demo', 'on', true)`);
      await m.query(`DELETE FROM incident_event WHERE tenant_id = 'acme'`);
    })).rejects.toThrow(/incident_event_append_only/);
    await expect(records.setPolicy(boss, Severity.High, 60, 30)).rejects.toThrow(/cannot be due before/);
    await expect(records.setPolicy(tech, Severity.High, 10, 30)).rejects.toThrow(/may not set/);
  });

  it(`down path (${MIGRATION}): the four tables are gone`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      expect(await owner.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_name IN ('incident', 'incident_alert', 'incident_event', 'incident_sla_policy')`,
      )).toEqual([{ n: 0 }]);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
