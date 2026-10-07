import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { IncidentService } from '../src/incident/incident.service';
import { createApp } from '../src/main';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'WorkOrderAlertLink1759000000000';
const SECRET = 'test-secret-work-order-alert-link';
const ISSUER = 'things-alive-work-order-alert-link-test';
const SS = 'iot-platform-1';

const acme: RequestScope = {
  tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false,
  capabilities: ['action.work', 'action.assign'],
};

/**
 * D-002, phase 1 manual testing (B6): a job raised from an alert could not say so —
 * the API refused `alertId` and the table had nowhere to keep it. Asserted by raising
 * the job, and by attempting the wrong link and expecting the service, and beneath it
 * the database, to refuse.
 */
describeDb('a work order raised from an alert (D-002)', () => {
  let owner: DataSource;
  let app: INestApplication;
  let orders: WorkOrderService;
  let incidents: IncidentService;

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
    orders = app.get(WorkOrderService);
    incidents = app.get(IncidentService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "work_order", "alert_event", "alert_rule", "equipment_profile" RESTART IDENTITY CASCADE`);
  });

  // ============================================================== fixtures
  const seedMachine = (tenant: string, externalId: string) => owner.query(
    `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, updated_by, name)
       VALUES ($1, $2, $3, 'dg', 1, 'standard', '{}'::jsonb, 'u', $4)`,
    [tenant, SS, externalId, `Machine ${externalId}`],
  );
  const seedAlert = async (tenant: string, externalId: string) => {
    const [rule] = await owner.query(
      `INSERT INTO alert_rule (tenant_id, slug, name, trigger, params, applies_to, severity, enabled)
         VALUES ($1, $2, 'Coolant high', 'signal-threshold', '{"signal":"coolant_temp_c"}'::jsonb, 'account', 'high', true) RETURNING id`,
      [tenant, `rule-${Math.random().toString(36).slice(2)}`],
    );
    const [row] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state)
         VALUES ($1, $2, 'Coolant high', $3, $4, 'high', 'Coolant above 105', '{}'::jsonb, 'open') RETURNING id`,
      [tenant, rule.id, SS, externalId],
    );
    return row.id as string;
  };
  const insertOrder = (tenant: string, externalId: string, alertId: string) => owner.query(
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, raised_by, alert_id)
       VALUES ($1, $2, $3, $4, 'Direct insert', 'created', 'normal', 'u', $5)`,
    [tenant, `WO-${Math.random().toString(36).slice(2, 8)}`, SS, externalId, alertId],
  );
  const orderCount = async () => Number((await owner.query(`SELECT count(*)::int AS n FROM work_order`))[0].n);

  // ============================================================== the link
  it('a job raised from an alert keeps the link, and the incident view carries it', async () => {
    await seedMachine('acme', 'DG-1');
    const alertId = await seedAlert('acme', 'DG-1');

    const order = await orders.raise(acme, { sourceSystem: SS, externalId: 'DG-1', title: 'Inspect cooling', alertId });
    expect(order.alertId).toBe(alertId);

    const [incident] = (await incidents.list(acme)).incidents;
    expect(incident.openWorkOrders).toEqual([expect.objectContaining({ id: order.id, alertId })]);
  });

  it('a job raised without an alert has no link — the column is optional', async () => {
    await seedMachine('acme', 'DG-1');
    const order = await orders.raise(acme, { sourceSystem: SS, externalId: 'DG-1', title: 'Routine inspection' });
    expect(order.alertId).toBeNull();
  });

  it('over HTTP: alertId is accepted and returned (it used to be refused as an unknown property)', async () => {
    await seedMachine('acme', 'DG-1');
    const alertId = await seedAlert('acme', 'DG-1');
    const token = new JwtService({}).sign(
      { sub: '00000000-0000-4000-8000-00000000ac01', client_id: 'acme', roles: ['super admin'] }, { secret: SECRET, issuer: ISSUER, expiresIn: 600 },
    );
    const res = await request(app.getHttpServer()).post('/api/v1/work-orders').set('Authorization', `Bearer ${token}`)
      .send({ sourceSystem: SS, externalId: 'DG-1', title: 'Inspect cooling', alertId });
    expect(res.status).toBe(201);
    expect(res.body.alertId).toBe(alertId);
  });

  // ============================================================== refusals
  it('the service refuses an alert on a different machine, and writes nothing', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    const onDg2 = await seedAlert('acme', 'DG-2');
    await expect(orders.raise(acme, { sourceSystem: SS, externalId: 'DG-1', title: 'Wrong machine', alertId: onDg2 }))
      .rejects.toThrow('That alert is on DG-2, not DG-1.');
    expect(await orderCount()).toBe(0);
  });

  it('the service refuses an alert from another account as if it did not exist', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('globex', 'DG-1');
    const theirs = await seedAlert('globex', 'DG-1');
    await expect(orders.raise(acme, { sourceSystem: SS, externalId: 'DG-1', title: 'Not ours', alertId: theirs }))
      .rejects.toThrow('No such alert in this account.');
    expect(await orderCount()).toBe(0);
  });

  it('the database refuses an alert on a different machine, whatever path wrote it', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    const onDg2 = await seedAlert('acme', 'DG-2');
    await expect(insertOrder('acme', 'DG-1', onDg2)).rejects.toMatchObject({ code: '23503' });
    expect(await orderCount()).toBe(0);
  });

  it('the database refuses an alert from another account, even on a machine with the same id', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('globex', 'DG-1');
    const theirs = await seedAlert('globex', 'DG-1');
    await expect(insertOrder('acme', 'DG-1', theirs)).rejects.toMatchObject({ code: '23503' });
    expect(await orderCount()).toBe(0);
  });

  // ============================================================== down path
  it(`down path (${MIGRATION}): the column, the foreign key and the alert_event constraint are gone`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ n: columns }] = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'work_order' AND column_name = 'alert_id'`,
    );
    expect(columns).toBe(0);
    const [{ n: constraints }] = await owner.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN ('fk_work_order_alert', 'uq_alert_event_machine_id')`,
    );
    expect(constraints).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
  });
});
