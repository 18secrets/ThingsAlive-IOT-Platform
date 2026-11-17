import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Acting on what a customer decided on a Vani call (D57, Lane D;
 * `1764000000000-VaniCallDecision.ts`, `src/vani/vani-decision.ts`).
 *
 * Through the real callback route, as Vani sends it, because what is worth proving is
 * end to end: the outcome is stored, the customer behind the dialled number is found
 * and given their own access, and the acknowledgement and the job happen once — or not
 * at all, with the reason written down. A "yes" on the phone does no more than the same
 * person could do signed in.
 */
const MIGRATION = 'VaniCallDecision1764000000000';
const CALLBACK_SECRET = 'shared-with-vani';
const SECRET = 'test-secret-vani-decision';
const ISSUER = 'things-alive-vani-decision-test';
const SRC = 'ta-2.0';

describeDb('vani: acting on what the customer decided', () => {
  let owner: DataSource;
  let app: INestApplication;
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const postOutcome = (body: unknown) => http()
    .post('/api/v1/vani/outcome-callback').set('X-Vani-Secret', CALLBACK_SECRET).send(body as object);

  /** A fresh critical alert on DG-01 and the call Vani was asked to make about it. */
  const newCall = async (phone: string | null = '+12012031340'): Promise<string> => {
    const [a] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('usa-test', gen_random_uuid(), 'Bearing vibration high', $1, 'DG-01', 'critical', 's', '{}'::jsonb, 'open', now())
       RETURNING id`, [SRC]);
    await owner.query(
      `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request, state, call_id, disposition)
         VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'critical', $2::jsonb, 'accepted', 'c1', 'dialed')`,
      [a.id, JSON.stringify(phone ? { customer_phone: phone } : {})]);
    return a.id;
  };
  const body = (alertId: string, over: Record<string, unknown> = {}) => ({
    event_id: alertId, call_id: 'c1', account_id: 'usa-test-01', machine_id: 'dg-01',
    outcome: 'completed_spoke_with_customer', attempt: 1,
    summary: 'Customer agreed to an inspection this week.', called_at: '2026-11-06T15:00:00-06:00',
    customer_decision: 'inspection_approved',
    ...over,
  });
  const action = async (alertId: string) => (await owner.query(
    `SELECT * FROM vani_call_action WHERE alert_event_id = $1`, [alertId]))[0] ?? null;
  const alertState = async (alertId: string) => (await owner.query(
    `SELECT state, acknowledged_by FROM alert_event WHERE id = $1`, [alertId]))[0];
  const jobs = (alertId: string): Promise<any[]> => owner.query(
    `SELECT * FROM work_order WHERE alert_id = $1`, [alertId]);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.VANI_CALLBACK_SECRET = CALLBACK_SECRET;
    app = await createApp({ database: true });
    await app.init();

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('usa-test', $1, 'DG-01', 'DG-01', 'client', 'active', 'basic', '{}'::jsonb)`, [SRC]);
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    await owner.query(`INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES
      ('usa-test', 'admin', 'Admin', ARRAY['prediction.read', 'action.assign'], 'tenant'),
      ('usa-test', 'viewer', 'Viewer', ARRAY['prediction.read'], 'tenant')`);
    const user = async (key: string, role: string, phone: string, status = 'active') => {
      const [u] = await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, phone) VALUES ('usa-test', $1, $2, $3, $4, $5) RETURNING id`,
        [`${key}@usa-test.example`, key, role, status, phone]);
      ids[key] = u.id;
    };
    await user('Deepak', 'admin', '+12012031340');
    await user('Vera', 'viewer', '+12025550122');
    await user('Ivan', 'admin', '+12025550199', 'invited');
  }, 60_000);

  afterAll(async () => {
    delete process.env.VANI_CALLBACK_SECRET;
    await app?.close(); await owner?.destroy();
  });

  it('acknowledges the alert when the customer acknowledged it, as that customer', async () => {
    const alertId = await newCall();
    expect((await postOutcome(body(alertId, { customer_decision: 'acknowledged' }))).status).toBe(200);
    expect(await alertState(alertId)).toEqual({ state: 'acknowledged', acknowledged_by: ids.Deepak });
    expect(await action(alertId)).toMatchObject({
      decision: 'acknowledged', status: 'acted', acknowledged: true, work_order_id: null, acted_as_user_id: ids.Deepak,
    });
    expect(await jobs(alertId)).toEqual([]);
  });

  it('raises the inspection the customer approved, linked to the alert, and acknowledges it', async () => {
    const alertId = await newCall();
    expect((await postOutcome(body(alertId))).status).toBe(200);
    const [job] = await jobs(alertId);
    expect(job).toMatchObject({
      external_id: 'DG-01', status: 'created', priority: 'high', assigned_to_user_id: null, raised_by: ids.Deepak,
      title: 'Inspection agreed on a Vani call: Bearing vibration high',
    });
    expect(job.description).toContain('Customer agreed to an inspection this week.');
    expect((await alertState(alertId)).state).toBe('acknowledged');
    expect(await action(alertId)).toMatchObject({ status: 'acted', acknowledged: true, work_order_id: job.id });
  });

  it('raises one job when the same callback arrives twice at the same moment', async () => {
    const alertId = await newCall();
    const both = await Promise.allSettled([postOutcome(body(alertId)), postOutcome(body(alertId))]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(both.map((r) => (r as PromiseFulfilledResult<request.Response>).value.status)).toEqual([200, 200]);
    expect(await jobs(alertId)).toHaveLength(1);
    expect(await owner.query(`SELECT 1 FROM vani_call_action WHERE alert_event_id = $1`, [alertId])).toHaveLength(1);
  });

  it('acts once per call, however many attempts report the decision', async () => {
    const alertId = await newCall();
    await postOutcome(body(alertId, { attempt: 1 }));
    await postOutcome(body(alertId, { attempt: 2 }));
    expect(await jobs(alertId)).toHaveLength(1);
  });

  it('does nothing on a decision from a call nobody spoke on', async () => {
    const alertId = await newCall();
    expect((await postOutcome(body(alertId, { outcome: 'voicemail_dropped' }))).status).toBe(200);
    expect(await action(alertId)).toMatchObject({ status: 'not_acted', reason: 'not_spoken_with_customer' });
    expect((await alertState(alertId)).state).toBe('open');
    expect(await jobs(alertId)).toEqual([]);
  });

  it('records a call-back request or a "no", and does nothing else', async () => {
    for (const decision of ['call_back_requested', 'declined']) {
      const alertId = await newCall();
      await postOutcome(body(alertId, { customer_decision: decision }));
      expect(await action(alertId)).toMatchObject({ decision, status: 'recorded', reason: null });
      expect((await alertState(alertId)).state).toBe('open');
      expect(await jobs(alertId)).toEqual([]);
    }
  });

  it('keeps the outcome but acts on no decision it does not know', async () => {
    const alertId = await newCall();
    expect((await postOutcome(body(alertId, { customer_decision: 'order_parts' }))).status).toBe(200);
    expect(await owner.query(`SELECT 1 FROM vani_call_outcome WHERE alert_event_id = $1`, [alertId])).toHaveLength(1);
    expect(await action(alertId)).toMatchObject({ decision: 'order_parts', status: 'not_acted', reason: 'unknown_decision' });
    expect((await alertState(alertId)).state).toBe('open');
  });

  it('does no more on the phone than the customer could signed in', async () => {
    // A viewer cannot raise jobs in the app. The acknowledgement that would have come
    // first is undone with it, so the row's "not acted" is the whole truth.
    const alertId = await newCall('+12025550122');
    await postOutcome(body(alertId));
    expect(await action(alertId)).toMatchObject({ status: 'not_acted', reason: 'not_permitted', acted_as_user_id: ids.Vera });
    expect((await alertState(alertId)).state).toBe('open');
    expect(await jobs(alertId)).toEqual([]);
  });

  it('does nothing on the word of somebody it cannot name, or who is not active', async () => {
    const stranger = await newCall('+12025550000');
    await postOutcome(body(stranger));
    expect(await action(stranger)).toMatchObject({ status: 'not_acted', reason: 'unknown_customer', acted_as_user_id: null });

    const invited = await newCall('+12025550199');
    await postOutcome(body(invited));
    expect(await action(invited)).toMatchObject({ status: 'not_acted', reason: 'customer_not_active' });
    expect(await jobs(stranger)).toEqual([]);
    expect(await jobs(invited)).toEqual([]);
  });

  it('shows the decision in the call history', async () => {
    const alertId = await newCall();
    await postOutcome(body(alertId));
    const token = await app.get(JwtService).signAsync(
      { sub: ids.Deepak, client_id: 'usa-test', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER });
    const res = await http().get(`/api/v1/vani/calls?alert=${alertId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const [job] = await jobs(alertId);
    expect(res.body[0].decision).toEqual({
      decision: 'inspection_approved', status: 'acted', reason: null, acknowledged: true, workOrderId: job.id,
    });
  });

  describe('the database', () => {
    const insert = (alertId: string, fields: Record<string, unknown>) => {
      const row = { tenant_id: 'usa-test', alert_event_id: alertId, attempt: 1, decision: 'acknowledged', status: 'recorded', ...fields };
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO vani_call_action (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row));
    };

    it('refuses a second action for one call', async () => {
      const alertId = await newCall();
      await insert(alertId, {});
      await expect(insert(alertId, { attempt: 2 })).rejects.toThrow(/uq_vani_call_action_call/);
    });

    it('refuses an action taken for nobody', async () => {
      const alertId = await newCall();
      await expect(insert(alertId, { status: 'acted' })).rejects.toThrow(/ck_vani_call_action_actor/);
    });

    it('refuses "not acted" without a reason, and a reason on anything else', async () => {
      const alertId = await newCall();
      await expect(insert(alertId, { status: 'not_acted' })).rejects.toThrow(/ck_vani_call_action_reason/);
      await expect(insert(alertId, { reason: 'because' })).rejects.toThrow(/ck_vani_call_action_reason/);
    });

    it('refuses a job raised for anything but an approved inspection', async () => {
      const alertId = await newCall();
      await postOutcome(body(alertId));
      const [job] = await jobs(alertId);
      const other = await newCall();
      await expect(insert(other, {
        status: 'acted', decision: 'declined', acted_as_user_id: ids.Deepak, work_order_id: job.id,
      })).rejects.toThrow(/ck_vani_call_action_work_order/);
    });

    it('refuses an action about a call Vani was never asked to make', async () => {
      await expect(insert('00000000-0000-4000-8000-000000000000', {})).rejects.toThrow(/fk_vani_call_action_call/);
    });

    it('lets the app record an action but never change one', async () => {
      const appDs = await createAppDataSource();
      try {
        await expect(appDs.query(`UPDATE vani_call_action SET status = 'acted'`)).rejects.toThrow(/permission denied/);
        await expect(appDs.query(`DELETE FROM vani_call_action`)).rejects.toThrow(/permission denied/);
      } finally {
        await appDs.destroy();
      }
    });
  });

  describe('the migration', () => {
    it('has a down path that leaves nothing behind', async () => {
      // Named, not undoLastMigration(): "last" stops meaning this one when another lands.
      await undoMigrationNamed(owner, MIGRATION);
      const [{ count }] = await owner.query(
        `SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'vani_call_action'`);
      expect(count).toBe(0);
      await owner.runMigrations({ transaction: 'all' });
    });
  });
});
