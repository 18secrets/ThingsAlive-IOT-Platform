import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { IncidentService } from '../src/incident/incident.service';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-incident-view';
const ISSUER = 'things-alive-incident-view-test';
const SS = 'iot-platform-1';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

/**
 * Incident Management, phase 1 (closeout §4): a view over open alerts and the work
 * orders beside them — no table, no lifecycle. Every assertion is about what the two
 * producers already hold and how the view carries it.
 */
describeDb('incident view', () => {
  let owner: DataSource;
  let app: INestApplication;
  let incidents: IncidentService;
  let alerts: AlertService;

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
    incidents = app.get(IncidentService);
    alerts = app.get(AlertService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "alert_event", "alert_rule", "work_order", "equipment_profile" RESTART IDENTITY CASCADE`);
  });

  // ============================================================== fixtures
  const seedMachine = (tenant: string, externalId: string) => owner.query(
    `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, updated_by, name)
       VALUES ($1, $2, $3, 'dg', 1, 'standard', '{}'::jsonb, 'u', $4)`,
    [tenant, SS, externalId, `Machine ${externalId}`],
  );

  const seedRule = async (tenant: string, signal: string | null) => {
    const [rule] = await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
         VALUES ($1, $2, 'Rule', 'signal-threshold', $3::jsonb, 'account', 'high', true) RETURNING id`,
      [tenant, `rule-${Math.random().toString(36).slice(2)}`, JSON.stringify(signal ? { signal } : {})],
    );
    return rule.id as string;
  };

  const seedAlert = async (
    tenant: string, externalId: string, ruleId: string,
    opts: { severity?: string; state?: string; firedAt?: Date } = {},
  ) => {
    const [row] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at, resolution_note)
         VALUES ($1, $2, 'Rule', $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9) RETURNING id`,
      [tenant, ruleId, SS, externalId, opts.severity ?? 'high', `Alert on ${externalId}`, opts.state ?? 'open', opts.firedAt ?? minutesAgo(10),
        opts.state === 'resolved' ? 'Dealt with' : null],
    );
    return row.id as string;
  };

  const seedWorkOrder = (tenant: string, externalId: string, status: string, title: string, priority = 'normal') => owner.query(
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, raised_by, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'u', $8)`,
    [tenant, `WO-${Math.random().toString(36).slice(2, 8)}`, SS, externalId, title, status, priority,
      status === 'completed' ? 'Done' : null],
  );

  // ================================================================== shape
  it('one row per machine with an open alert, worst severity first, its alerts and open jobs beside it', async () => {
    for (const id of ['DG-1', 'DG-2', 'DG-3', 'DG-4']) await seedMachine('acme', id);
    const coolant = await seedRule('acme', 'coolant_temp_c');
    const chain = await seedRule('acme', null);

    await seedAlert('acme', 'DG-1', coolant, { severity: 'medium', firedAt: minutesAgo(5) });
    await seedAlert('acme', 'DG-2', coolant, { severity: 'low', firedAt: minutesAgo(30) });
    await seedAlert('acme', 'DG-2', chain, { severity: 'critical', state: 'acknowledged', firedAt: minutesAgo(20) });
    // Resolved is not open: DG-3 is not in an incident.
    await seedAlert('acme', 'DG-3', coolant, { severity: 'critical', state: 'resolved' });

    await seedWorkOrder('acme', 'DG-2', 'in-progress', 'Check coolant loop', 'urgent');
    await seedWorkOrder('acme', 'DG-2', 'completed', 'Last month\'s service');
    // A job with no open alert does not make an incident on its own.
    await seedWorkOrder('acme', 'DG-4', 'created', 'Routine inspection');

    const list = await incidents.list(acme);
    expect(list.status).toBe('open');
    expect(list.incidents.map((i) => [i.machine.externalId, i.worstSeverity])).toEqual([['DG-2', 'critical'], ['DG-1', 'medium']]);

    const [dg2, dg1] = list.incidents;
    expect(dg2.machine).toEqual({ sourceSystem: SS, externalId: 'DG-2', name: 'Machine DG-2', classSlug: 'dg', plantId: null });
    // Newest first; the acknowledged one is still open, and says so.
    expect(dg2.openAlerts.map((a) => [a.severity, a.acknowledged, a.signal])).toEqual([
      ['critical', true, null],
      ['low', false, 'coolant_temp_c'],
    ]);
    expect(dg2.latestRaisedAt).toBe(minutesAgo(20).toISOString());
    expect(dg2.openWorkOrders).toEqual([expect.objectContaining({ title: 'Check coolant loop', status: 'in-progress', priority: 'urgent' })]);
    expect(dg1.openWorkOrders).toEqual([]);
  });

  it('the view follows the alert: acknowledging keeps the machine listed, resolving removes it — nothing of its own to close', async () => {
    await seedMachine('acme', 'DG-1');
    const rule = await seedRule('acme', 'coolant_temp_c');
    const id = await seedAlert('acme', 'DG-1', rule);

    await alerts.acknowledge(acme, id, NOW);
    expect((await incidents.list(acme)).incidents[0].openAlerts[0].acknowledged).toBe(true);

    await alerts.resolve(acme, id, 'Topped up coolant', NOW);
    expect((await incidents.list(acme)).incidents).toEqual([]);
  });

  it('equal severity: the most recently raised machine first', async () => {
    for (const id of ['DG-1', 'DG-2']) await seedMachine('acme', id);
    const rule = await seedRule('acme', 'coolant_temp_c');
    await seedAlert('acme', 'DG-1', rule, { firedAt: minutesAgo(60) });
    await seedAlert('acme', 'DG-2', rule, { firedAt: minutesAgo(1) });
    expect((await incidents.list(acme)).incidents.map((i) => i.machine.externalId)).toEqual(['DG-2', 'DG-1']);
  });

  it('a machine with an open alert and no profile is still listed — an incident does not wait for paperwork', async () => {
    const rule = await seedRule('acme', 'coolant_temp_c');
    await seedAlert('acme', 'UNPROFILED-9', rule);
    const [incident] = (await incidents.list(acme)).incidents;
    expect(incident.machine).toEqual({ sourceSystem: SS, externalId: 'UNPROFILED-9', name: null, classSlug: null, plantId: null });
  });

  it('every open alert is listed — the alert list\'s 200 cap does not silently drop machines here', async () => {
    const rule = await seedRule('acme', 'coolant_temp_c');
    await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         SELECT 'acme', $1, 'Rule', $2, 'DG-' || g, 'high', 'Alert', '{}'::jsonb, 'open', $3::timestamptz - (g || ' minutes')::interval
           FROM generate_series(1, 210) AS g`,
      [rule, SS, NOW],
    );
    expect((await incidents.list(acme)).incidents).toHaveLength(210);
    // The alert list itself is unchanged.
    expect(await alerts.listEvents(acme, { state: ['open'] })).toHaveLength(200);
  });

  // ============================================================== visibility
  it('another tenant\'s incidents are invisible', async () => {
    await seedMachine('globex', 'GX-1');
    const rule = await seedRule('globex', 'coolant_temp_c');
    await seedAlert('globex', 'GX-1', rule);
    expect((await incidents.list(acme)).incidents).toEqual([]);
  });

  it('a user scoped to some machines sees incidents on those machines only', async () => {
    for (const id of ['DG-1', 'DG-2']) await seedMachine('acme', id);
    const rule = await seedRule('acme', 'coolant_temp_c');
    await seedAlert('acme', 'DG-1', rule);
    await seedAlert('acme', 'DG-2', rule);
    await seedWorkOrder('acme', 'DG-1', 'created', 'Mine');
    await seedWorkOrder('acme', 'DG-2', 'created', 'Not mine');

    const operator: RequestScope = { ...acme, equipmentIds: ['DG-1'] };
    const list = await incidents.list(operator);
    expect(list.incidents.map((i) => i.machine.externalId)).toEqual(['DG-1']);
    expect(list.incidents[0].openWorkOrders?.map((o) => o.title)).toEqual(['Mine']);
  });

  it('a caller without action.work gets the alerts and null for the jobs — not an empty list that claims there are none', async () => {
    await seedMachine('acme', 'DG-1');
    const rule = await seedRule('acme', 'coolant_temp_c');
    await seedAlert('acme', 'DG-1', rule);
    await seedWorkOrder('acme', 'DG-1', 'created', 'A job they cannot read');

    const viewer: RequestScope = { ...acme, capabilities: ['prediction.read', 'catalog.read'] };
    const [incident] = (await incidents.list(viewer)).incidents;
    expect(incident.openAlerts).toHaveLength(1);
    expect(incident.openWorkOrders).toBeNull();
  });

  // ==================================================================== HTTP
  const bearer = (roles: string[]) => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000e1', client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER },
  );

  it('GET /api/v1/incidents?status=open answers; any other status is refused, not read as open', async () => {
    await seedMachine('acme', 'DG-1');
    const rule = await seedRule('acme', 'coolant_temp_c');
    await seedAlert('acme', 'DG-1', rule);
    const token = await bearer(['super admin']);

    const ok = await request(app.getHttpServer()).get('/api/v1/incidents?status=open').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.incidents.map((i: { machine: { externalId: string } }) => i.machine.externalId)).toEqual(['DG-1']);

    const closed = await request(app.getHttpServer()).get('/api/v1/incidents?status=closed').set('Authorization', `Bearer ${token}`);
    expect(closed.status).toBe(400);
  });
});
