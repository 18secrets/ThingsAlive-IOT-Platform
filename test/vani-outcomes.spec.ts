import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { VaniResponse, VaniTransport } from '../src/vani/vani-client';
import { SNAPSHOT_RETRY_MS, VaniSnapshotPusher } from '../src/vani/vani-snapshot';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * What Vani is told about an account's machines, and what Vani tells us back
 * (integration guide §6.3, §6.4).
 *
 * The callback is exercised over HTTP through the real application, because the
 * things worth proving there — no token, a shared secret, an unknown field not costing
 * the outcome, a repeated callback writing once — live in the route and the pipe as
 * much as in the service.
 */
class ScriptedVani implements VaniTransport {
  configured = true;
  sent: { path: string; body: any }[] = [];
  constructor(public answer: (body: any) => VaniResponse) {}
  async post(path: string, body: unknown): Promise<VaniResponse> {
    this.sent.push({ path, body });
    return this.answer(body);
  }
}
const ok = (b: any): VaniResponse => ({ status: 200, body: { ok: true, account_id: b.account_id, received_at: 'now' } });

const SECRET = 'test-secret-vani-outcomes';
const ISSUER = 'things-alive-vani-outcomes-test';
const CALLBACK_SECRET = 'shared-with-vani';
const SRC = 'ta-2.0';

describeDb('vani: snapshots out, outcomes in', () => {
  let owner: DataSource;
  let appDs: DataSource;
  let app: INestApplication;
  let alertId: string;

  const http = () => request(app.getHttpServer());
  const auth = async (tenant: string, roles = ['admin']) => `Bearer ${await app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000f1', client_id: tenant, roles }, { secret: SECRET, issuer: ISSUER })}`;

  const outcomeBody = (over: Record<string, unknown> = {}) => ({
    event_id: alertId,
    call_id: 'f89d1ee47b1c',
    account_id: 'usa-test-01',
    machine_id: 'dg-01',
    outcome: 'completed_spoke_with_customer',
    summary: 'Customer answered and spoke with Vani about Diesel Generator DG-01; no follow-up booked.',
    duration_s: 0.0,
    attempt: 1,
    called_at: '2026-11-04T04:18:20+00:00',
    ...over,
  });
  const postOutcome = (body: unknown, secret: string | null = CALLBACK_SECRET) => {
    const r = http().post('/api/v1/vani/outcome-callback');
    return (secret === null ? r : r.set('X-Vani-Secret', secret)).send(body as object);
  };
  const outcomes = (): Promise<any[]> => owner.query(`SELECT * FROM vani_call_outcome ORDER BY attempt`);

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
    appDs = await createAppDataSource();

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client'), ('globex', 'Globex')`);
    for (const ext of ['DG-01', 'DG-02']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ('usa-test', $1, $2, $2, 'client', 'active', 'basic', '{}'::jsonb)`, [SRC, ext]);
    }
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`, [SRC]);
    const [a] = await owner.query(
      // Resolved, so the snapshot starts from a machine with nothing open on it.
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at,
                                resolved_by, resolved_at, resolution_note)
         VALUES ('usa-test', gen_random_uuid(), 'Main bearing temperature rising', $1, 'DG-01', 'critical',
                 'Main bearing temperature up 9 degrees over 72 hours', '{}'::jsonb, 'resolved', now(),
                 'deepak', now(), 'Bearing inspected and regreased')
       RETURNING id`, [SRC]);
    alertId = a.id;
    await owner.query(
      `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request, state, call_id, disposition)
         VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'critical', '{}'::jsonb, 'accepted', 'f89d1ee47b1c', 'dialed')`,
      [alertId]);
  }, 60_000);

  afterAll(async () => {
    delete process.env.VANI_CALLBACK_SECRET;
    await appDs?.destroy(); await app?.close(); await owner?.destroy();
  });

  describe('account snapshot', () => {
    beforeEach(async () => {
      await owner.query(`UPDATE vani_account_link SET snapshot_hash = NULL, snapshot_refused_hash = NULL,
        snapshot_error = NULL, snapshot_attempted_at = NULL, snapshot_pushed_at = NULL`);
      await owner.query(`DELETE FROM alert_event WHERE id <> $1`, [alertId]);
    });

    const openAlert = (name: string, severity: string) => owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('usa-test', gen_random_uuid(), $1, $2, 'DG-01', $3, 's', '{}'::jsonb, 'open', now())`, [name, SRC, severity]);

    it('pushes the linked machines once, then not again until something changes', async () => {
      const vani = new ScriptedVani(ok);
      const pusher = new VaniSnapshotPusher(appDs, vani);
      const now = new Date();
      expect((await pusher.pass(now)).pushed).toBe(1);
      expect(vani.sent).toEqual([{
        path: '/platform/account-snapshot',
        body: {
          account_id: 'usa-test-01',
          generated_at: now.toISOString(),
          // DG-02 is not linked, so Vani never hears of it. No health_score: 2.0 has none.
          machines: [{ machine_id: 'dg-01', name: 'Diesel Generator DG-01', status: 'No open alerts' }],
        },
      }]);
      expect((await pusher.pass(new Date())).unchanged).toBe(1);
      expect(vani.sent).toHaveLength(1);
    });

    it('pushes again when an alert opens, naming the most serious one', async () => {
      const vani = new ScriptedVani(ok);
      const pusher = new VaniSnapshotPusher(appDs, vani);
      await pusher.pass();
      await openAlert('Low fuel', 'medium');
      await openAlert('Main bearing temperature rising', 'critical');
      expect((await pusher.pass()).pushed).toBe(1);
      expect(vani.sent[1].body.machines[0].status).toBe('2 open alerts, the most serious: Main bearing temperature rising');
    });

    it('does not resend a picture Vani refused, but sends a changed one', async () => {
      let refuse = true;
      const vani = new ScriptedVani((b) => (refuse ? { status: 422, body: { error: 'unknown account_id' } } : ok(b)));
      const pusher = new VaniSnapshotPusher(appDs, vani);
      expect((await pusher.pass()).refused).toBe(1);
      await pusher.pass(new Date(Date.now() + SNAPSHOT_RETRY_MS * 2));
      expect(vani.sent).toHaveLength(1);
      const [link] = await owner.query(`SELECT snapshot_error, snapshot_hash FROM vani_account_link`);
      expect(link).toEqual({ snapshot_error: 'unknown account_id', snapshot_hash: null });

      refuse = false;
      await openAlert('Low fuel', 'medium');
      expect((await pusher.pass(new Date(Date.now() + SNAPSHOT_RETRY_MS * 2))).pushed).toBe(1);
    });

    it('waits before retrying after an outage', async () => {
      let down = true;
      const vani = new ScriptedVani((b) => (down ? { status: 503, body: {} } : ok(b)));
      const pusher = new VaniSnapshotPusher(appDs, vani);
      const t0 = new Date();
      expect((await pusher.pass(t0)).failed).toBe(1);
      await pusher.pass(new Date(t0.getTime() + 60_000));
      expect(vani.sent).toHaveLength(1);
      down = false;
      expect((await pusher.pass(new Date(t0.getTime() + SNAPSHOT_RETRY_MS + 1))).pushed).toBe(1);
    });

    it('sends nothing until Vani is configured', async () => {
      const vani = new ScriptedVani(ok);
      vani.configured = false;
      expect(await new VaniSnapshotPusher(appDs, vani).pass()).toEqual({ pushed: 0, unchanged: 0, refused: 0, failed: 0 });
      expect(vani.sent).toEqual([]);
    });
  });

  describe('outcome callback', () => {
    beforeEach(async () => {
      process.env.VANI_CALLBACK_SECRET = CALLBACK_SECRET;
      await owner.query(`DELETE FROM vani_call_outcome`);
    });

    it('refuses every callback while no secret is configured', async () => {
      delete process.env.VANI_CALLBACK_SECRET;
      expect((await postOutcome(outcomeBody())).status).toBe(503);
      expect(await outcomes()).toEqual([]);
    });

    it('refuses a wrong or missing secret', async () => {
      expect((await postOutcome(outcomeBody(), 'guess')).status).toBe(401);
      expect((await postOutcome(outcomeBody(), null)).status).toBe(401);
      expect(await outcomes()).toEqual([]);
    });

    it('records what Vani reported, as sent', async () => {
      const res = await postOutcome(outcomeBody());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, duplicate: false });
      const [row] = await outcomes();
      expect(row).toMatchObject({
        tenant_id: 'usa-test', alert_event_id: alertId, attempt: 1, call_id: 'f89d1ee47b1c',
        outcome: 'completed_spoke_with_customer',
        summary: 'Customer answered and spoke with Vani about Diesel Generator DG-01; no follow-up booked.',
      });
      expect(row.called_at.toISOString()).toBe('2026-11-04T04:18:20.000Z');
    });

    it('acknowledges a repeated callback without writing it twice', async () => {
      await postOutcome(outcomeBody());
      const again = await postOutcome(outcomeBody());
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true, duplicate: true });
      expect(await outcomes()).toHaveLength(1);
    });

    it('writes once when the same callback arrives twice at the same moment', async () => {
      const both = await Promise.allSettled([postOutcome(outcomeBody()), postOutcome(outcomeBody())]);
      expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const statuses = both.map((r) => (r as PromiseFulfilledResult<request.Response>).value.status);
      expect(statuses).toEqual([200, 200]);
      expect(await outcomes()).toHaveLength(1);
    });

    it('keeps each attempt', async () => {
      await postOutcome(outcomeBody({ attempt: 1, outcome: 'no_answer' }));
      await postOutcome(outcomeBody({ attempt: 2, outcome: 'voicemail_dropped' }));
      expect((await outcomes()).map((o) => o.outcome)).toEqual(['no_answer', 'voicemail_dropped']);
    });

    it('does not lose an outcome because Vani added a field', async () => {
      const res = await postOutcome(outcomeBody({ sentiment: 'calm' }));
      expect(res.status).toBe(200);
      expect((await outcomes())[0].payload.sentiment).toBe('calm');
    });

    it('refuses an outcome for an event we never asked Vani about', async () => {
      expect((await postOutcome(outcomeBody({ event_id: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
      expect((await postOutcome(outcomeBody({ event_id: 'test-20261103-2217' }))).status).toBe(400);
    });

    it('refuses an outcome that names a different account or machine than the call', async () => {
      expect((await postOutcome(outcomeBody({ account_id: 'someone-else' }))).status).toBe(400);
      expect((await postOutcome(outcomeBody({ machine_id: 'dg-99' }))).status).toBe(400);
      expect(await outcomes()).toEqual([]);
    });

    it('refuses an outcome Vani does not send, and says why', async () => {
      const res = await postOutcome(outcomeBody({ outcome: 'answered' }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not one Vani sends/);
    });
  });

  describe('call history', () => {
    beforeAll(async () => {
      process.env.VANI_CALLBACK_SECRET = CALLBACK_SECRET;
      await owner.query(`DELETE FROM vani_call_outcome`);
      await postOutcome(outcomeBody({ attempt: 1, outcome: 'no_answer', summary: 'No answer.' }));
      await postOutcome(outcomeBody({ attempt: 2, outcome: 'voicemail_dropped', summary: 'Voicemail left.' }));
    });

    it('shows a call with its attempts, in order', async () => {
      const res = await http().get(`/api/v1/vani/calls?alert=${alertId}`).set('Authorization', await auth('usa-test'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        alertEventId: alertId, externalId: 'DG-01', alertName: 'Main bearing temperature rising',
        machineId: 'dg-01', state: 'accepted', disposition: 'dialed',
      });
      expect(res.body[0].outcomes.map((o: any) => [o.attempt, o.outcome, o.summary]))
        .toEqual([[1, 'no_answer', 'No answer.'], [2, 'voicemail_dropped', 'Voicemail left.']]);
    });

    it('shows another account nothing', async () => {
      const res = await http().get('/api/v1/vani/calls').set('Authorization', await auth('globex'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('refuses an anonymous caller', async () => {
      expect((await http().get('/api/v1/vani/calls')).status).toBe(401);
    });

    it('refuses a malformed alert id rather than passing it to the database', async () => {
      const res = await http().get('/api/v1/vani/calls?alert=nope').set('Authorization', await auth('usa-test'));
      expect(res.status).toBe(400);
    });
  });
});
