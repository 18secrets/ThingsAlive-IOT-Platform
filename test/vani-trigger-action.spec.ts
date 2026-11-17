import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Severity } from '../src/common/severity';
import { createApp } from '../src/main';
import { VaniCallSender } from '../src/vani/vani-call-sender';
import { VaniResponse, VaniTransport } from '../src/vani/vani-client';
import { queueVaniPredictionCalls, ScoredPrediction } from '../src/vani/vani-prediction-queue';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * Calls about a prediction that raised no alert (D57, Lane B;
 * `1764100000000-VaniTriggerActions.ts`, `src/vani/vani-prediction-queue.ts`).
 *
 * The rules worth proving are the ones that keep a customer from being rung for the
 * wrong reason: only a live, high-or-critical, fully read prediction; never twice for
 * the same machine, scenario and day; never on top of an alert already covering it.
 * Queued through `ta_app`, as the shift runner does, so a grant or a policy that would
 * refuse it in production refuses it here.
 */
class ScriptedVani implements VaniTransport {
  configured = true;
  sent: { path: string; body: any }[] = [];
  async post(path: string, body: any): Promise<VaniResponse> {
    this.sent.push({ path, body });
    return { status: 202, body: { event_id: body.event_id, call_id: 'p-call-1', status: 'queued', disposition: 'dialed' } };
  }
}

const MIGRATION = 'VaniTriggerActions1764100000000';
const CALLBACK_SECRET = 'shared-with-vani';
const SECRET = 'test-secret-vani-trigger';
const ISSUER = 'things-alive-vani-trigger-test';
const SRC = 'ta-2.0';
const WINDOW = { tenantId: 'usa-test', sourceSystem: SRC, externalId: 'DG-01', localDate: '2026-11-06' };

describeDb('vani: calls about predictions that raised no alert', () => {
  let owner: DataSource;
  let appDs: DataSource;
  let app: INestApplication;
  let deepak: string;

  const prediction = (over: Partial<ScoredPrediction> = {}): ScoredPrediction => ({
    id: randomUUID(), clientScenarioSlug: 'bearing-wear', severity: Severity.High, confidence: 'full',
    source: 'live', riskScore: 71.4, abnormalCount: 2, occurredAt: new Date('2026-11-06T14:00:00Z'), ...over,
  });
  const calls = (): Promise<any[]> => owner.query(`SELECT * FROM vani_call ORDER BY created_at, id`);
  const postOutcome = (body: unknown) => request(app.getHttpServer())
    .post('/api/v1/vani/outcome-callback').set('X-Vani-Secret', CALLBACK_SECRET).send(body as object);

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
    appDs = await createAppDataSource();

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client')`);
    for (const ext of ['DG-01', 'DG-02']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ('usa-test', $1, $2, $2, 'client', 'active', 'basic', '{}'::jsonb)`, [SRC, ext]);
    }
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone)
      VALUES ('usa-test', 'usa-test-01', '+12012031340')`);
    await owner.query(`INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
      VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`, [SRC]);
    await owner.query(`INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape)
      VALUES ('usa-test', 'admin', 'Admin', ARRAY['prediction.read', 'action.assign'], 'tenant')`);
    const [u] = await owner.query(`INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, phone)
      VALUES ('usa-test', 'deepak@usa-test.example', 'Deepak', 'admin', 'active', '+12012031340') RETURNING id`);
    deepak = u.id;
  }, 60_000);

  afterAll(async () => {
    delete process.env.VANI_CALLBACK_SECRET;
    await appDs?.destroy(); await app?.close(); await owner?.destroy();
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE vani_call_action, vani_call_outcome, vani_call, alert_event CASCADE`);
    await owner.query(`DELETE FROM work_order`);
    await owner.query(`UPDATE vani_account_link SET enabled = true`);
  });

  describe('which predictions earn a call', () => {
    it('asks for a call about a live, high, fully read prediction, in words Vani can say', async () => {
      const p = prediction();
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [p])).toBe(1);
      const [call] = await calls();
      expect(call).toMatchObject({
        kind: 'trigger_action', alert_event_id: null, prediction_id: p.id, external_id: 'DG-01',
        client_scenario_slug: 'bearing-wear', machine_id: 'dg-01', severity: 'warning', state: 'pending',
      });
      expect(call.event_id).toBe(call.trigger_event_id);
      expect(call.request).toEqual({
        event_id: call.trigger_event_id,
        account_id: 'usa-test-01',
        customer_phone: '+12012031340',
        machine: { machine_id: 'dg-01', name: 'Diesel Generator DG-01' },
        trigger: {
          kind: 'trigger_action', severity: 'warning',
          title: 'bearing wear risk on Diesel Generator DG-01', fired_at: '2026-11-06T14:00:00.000Z',
        },
        context: {
          alert_title: 'bearing wear risk on Diesel Generator DG-01',
          summary: expect.stringContaining('at high risk, 71 out of 100, with 2 signals outside their normal range'),
          prediction: expect.stringContaining('It was read from every signal that prediction uses.'),
          confidence: 'full',
        },
      });
    });

    it('calls about a critical one at Vani\'s critical tier', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction({ severity: Severity.Critical })]);
      expect((await calls())[0].severity).toBe('critical');
    });

    it('does not call about a partly read, a medium or a replayed prediction', async () => {
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [
        prediction({ confidence: 'partial' }),
        prediction({ severity: Severity.Medium, clientScenarioSlug: 'oil-temp' }),
        prediction({ source: 'replayed', clientScenarioSlug: 'coolant' }),
      ])).toBe(0);
      expect(await calls()).toEqual([]);
    });

    it('does not call about a machine Vani does not know, or while the account is off', async () => {
      expect(await queueVaniPredictionCalls(appDs, { ...WINDOW, externalId: 'DG-02' }, [prediction()])).toBe(0);
      await owner.query(`UPDATE vani_account_link SET enabled = false`);
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [prediction()])).toBe(0);
      expect(await calls()).toEqual([]);
    });

    it('does not ring twice when an alert from the same scenario is already open', async () => {
      const [p] = await owner.query(
        `INSERT INTO prediction (tenant_id, source_system, external_id, client_scenario_slug, severity, risk_score,
                                 confidence, window_days, occurred_at)
           VALUES ('usa-test', $1, 'DG-01', 'bearing-wear', 'high', 70, 'full', 7, now()) RETURNING id`, [SRC]);
      await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence,
                                  state, fired_at, prediction_id)
           VALUES ('usa-test', gen_random_uuid(), 'Bearing wear', $1, 'DG-01', 'high', 's', '{}'::jsonb, 'open', now(), $2)`,
        [SRC, p.id]);
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [prediction()])).toBe(0);
      // A different scenario on the same machine is still news.
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [prediction({ clientScenarioSlug: 'oil-temp' })])).toBe(1);
    });

    it('calls once per machine, scenario and day, and again the next day', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction()]);
      expect(await queueVaniPredictionCalls(appDs, WINDOW, [prediction()])).toBe(0);
      expect(await queueVaniPredictionCalls(appDs, { ...WINDOW, localDate: '2026-11-07' }, [prediction()])).toBe(1);
      expect(await calls()).toHaveLength(2);
    });

    it('asks once when two passes queue the same scenario at the same moment', async () => {
      const both = await Promise.allSettled([
        queueVaniPredictionCalls(appDs, WINDOW, [prediction()]),
        queueVaniPredictionCalls(appDs, WINDOW, [prediction()]),
      ]);
      expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await calls()).toHaveLength(1);
    });
  });

  describe('the rest of the call', () => {
    it('is sent as Vani\'s trigger_action, under its own event id', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction()]);
      const vani = new ScriptedVani();
      expect((await new VaniCallSender(appDs, vani).pass(new Date(Date.now() + 1_000))).accepted).toBe(1);
      const [call] = await calls();
      expect(vani.sent[0].path).toBe('/platform/alert-call');
      expect(vani.sent[0].body.trigger.kind).toBe('trigger_action');
      expect(vani.sent[0].body.event_id).toBe(call.event_id);
      expect(call.state).toBe('accepted');
    });

    it('records the outcome, and raises the inspection the customer approved on the machine', async () => {
      const p = prediction();
      await queueVaniPredictionCalls(appDs, WINDOW, [p]);
      const [call] = await calls();
      const res = await postOutcome({
        event_id: call.event_id, account_id: 'usa-test-01', machine_id: 'dg-01', attempt: 1,
        outcome: 'completed_spoke_with_customer', summary: 'Customer wants the bearing checked.',
        customer_decision: 'inspection_approved',
      });
      expect(res.status).toBe(200);
      const [job] = await owner.query(`SELECT * FROM work_order`);
      expect(job).toMatchObject({
        external_id: 'DG-01', alert_id: null, prediction_id: p.id, raised_by: deepak, priority: 'normal',
        title: 'Inspection agreed on a Vani call: bearing wear',
      });
      const [action] = await owner.query(`SELECT * FROM vani_call_action`);
      expect(action).toMatchObject({ status: 'acted', acknowledged: false, work_order_id: job.id });
    });

    it('records an acknowledgement of a prediction call, with no alert to acknowledge', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction()]);
      const [call] = await calls();
      await postOutcome({
        event_id: call.event_id, account_id: 'usa-test-01', machine_id: 'dg-01', attempt: 1,
        outcome: 'completed_spoke_with_customer', customer_decision: 'acknowledged',
      });
      expect((await owner.query(`SELECT status FROM vani_call_action`))[0].status).toBe('recorded');
    });

    it('shows the prediction call in the call history', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction()]);
      const token = await app.get(JwtService).signAsync(
        { sub: deepak, client_id: 'usa-test', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER });
      const res = await request(app.getHttpServer()).get('/api/v1/vani/calls?equipment=DG-01')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({
        kind: 'trigger_action', alertEventId: null, externalId: 'DG-01', sourceSystem: SRC,
        scenarioName: 'bearing-wear', alertName: null,
      });
    });

    it('still uses the alert\'s own id as an alert call\'s event id', async () => {
      const [a] = await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
           VALUES ('usa-test', gen_random_uuid(), 'r', $1, 'DG-01', 'high', 's', '{}'::jsonb, 'open', now()) RETURNING id`, [SRC]);
      await owner.query(`INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request)
        VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'warning', '{}'::jsonb)`, [a.id]);
      const [call] = await calls();
      expect(call).toMatchObject({ kind: 'alert', event_id: a.id });
    });
  });

  describe('the database', () => {
    const insertTrigger = (fields: Record<string, unknown> = {}) => {
      const row = {
        tenant_id: 'usa-test', kind: 'trigger_action', trigger_event_id: randomUUID(),
        prediction_id: randomUUID(), source_system: SRC, external_id: 'DG-01', client_scenario_slug: 'bearing-wear',
        trigger_day: '2026-11-06', vani_account_id: 'usa-test-01', machine_id: 'dg-01', severity: 'warning', request: '{}',
        ...fields,
      };
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO vani_call (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row));
    };

    it('refuses a prediction call that names no prediction, or names an alert', async () => {
      await expect(insertTrigger({ prediction_id: null })).rejects.toThrow(/ck_vani_call_kind/);
      const [a] = await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
           VALUES ('usa-test', gen_random_uuid(), 'r', $1, 'DG-01', 'high', 's', '{}'::jsonb, 'open', now()) RETURNING id`, [SRC]);
      await expect(insertTrigger({ alert_event_id: a.id })).rejects.toThrow(/ck_vani_call_kind/);
    });

    it('refuses an alert call that carries a prediction call\'s fields', async () => {
      const [a] = await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
           VALUES ('usa-test', gen_random_uuid(), 'r', $1, 'DG-01', 'high', 's', '{}'::jsonb, 'open', now()) RETURNING id`, [SRC]);
      await expect(owner.query(
        `INSERT INTO vani_call (tenant_id, alert_event_id, trigger_event_id, vani_account_id, machine_id, severity, request)
           VALUES ('usa-test', $1, gen_random_uuid(), 'usa-test-01', 'dg-01', 'warning', '{}'::jsonb)`, [a.id],
      )).rejects.toThrow(/ck_vani_call_kind/);
    });

    it('refuses a second prediction call for the same machine, scenario and day', async () => {
      await insertTrigger();
      await expect(insertTrigger()).rejects.toThrow(/uq_vani_call_prediction_day/);
    });

    it('refuses changing what a prediction call was about', async () => {
      await insertTrigger();
      await expect(owner.query(`UPDATE vani_call SET client_scenario_slug = 'oil-temp'`)).rejects.toThrow(/cannot change/);
      await expect(owner.query(`UPDATE vani_call SET prediction_id = gen_random_uuid()`)).rejects.toThrow(/cannot change/);
    });

    it('refuses an outcome under an event id no call has', async () => {
      await expect(owner.query(
        `INSERT INTO vani_call_outcome (tenant_id, alert_event_id, attempt, outcome, payload)
           VALUES ('usa-test', gen_random_uuid(), 1, 'no_answer', '{}'::jsonb)`,
      )).rejects.toThrow(/fk_vani_call_outcome_call/);
    });
  });

  describe('the migration', () => {
    it('will not roll back over a prediction call', async () => {
      await queueVaniPredictionCalls(appDs, WINDOW, [prediction()]);
      await expect(undoMigrationNamed(owner, MIGRATION)).rejects.toThrow();
      expect((await calls())[0].kind).toBe('trigger_action');
    });

    it('has a down path that leaves alert calls as they were', async () => {
      // Named, not undoLastMigration(): "last" stops meaning this one when another lands.
      await undoMigrationNamed(owner, MIGRATION);
      const cols = await owner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'vani_call' AND column_name = ANY($1)`,
        [['kind', 'event_id', 'trigger_event_id', 'prediction_id']]);
      expect(cols).toEqual([]);
      await owner.runMigrations({ transaction: 'all' });
    });
  });
});
