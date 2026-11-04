import { DataSource, EntityManager } from 'typeorm';
import { AlertEvent } from '../src/alert/entities/alert-event.entity';
import { Severity } from '../src/common/severity';
import { MAX_ATTEMPTS, VaniCallSender } from '../src/vani/vani-call-sender';
import { VaniResponse, VaniTransport } from '../src/vani/vani-client';
import { queueVaniCalls } from '../src/vani/vani-queue';
import { vaniSeverity } from '../src/vani/vani-severity';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Asking Vani to phone about an alert (integration guide §6.1, §6.2).
 *
 * Vani is replaced by a scripted transport, because the real one rings a real phone.
 * Everything on our side runs for real: the queue writes through `ta_app` inside a
 * tenant session, and the sender claims rows through the same tenant-spanning
 * transaction it uses in production.
 */
describe('vani severity', () => {
  it('maps every one of ours, and only those', () => {
    expect(vaniSeverity(Severity.Critical, {})).toBe('critical');
    expect(vaniSeverity(Severity.Medium, {})).toBe('warning');
    expect(vaniSeverity(Severity.Low, {})).toBe('warning');
    expect(vaniSeverity(Severity.None, {})).toBe('info');
    expect(() => vaniSeverity('severe' as Severity, {})).toThrow(/No Vani severity/);
  });

  it('holds high until business hours unless told otherwise', () => {
    expect(vaniSeverity(Severity.High, {})).toBe('warning');
    expect(vaniSeverity(Severity.High, { VANI_HIGH_SEVERITY: 'critical' })).toBe('critical');
    // A typo must not quietly become either answer.
    expect(() => vaniSeverity(Severity.High, { VANI_HIGH_SEVERITY: 'urgent' })).toThrow(/VANI_HIGH_SEVERITY/);
  });
});

/** A Vani that answers from a script and remembers what it was sent. */
class ScriptedVani implements VaniTransport {
  configured = true;
  sent: { path: string; body: any }[] = [];
  constructor(public answer: (body: any) => VaniResponse | Promise<VaniResponse>) {}
  async post(path: string, body: unknown): Promise<VaniResponse> {
    this.sent.push({ path, body });
    return this.answer(body);
  }
}

const dialed = (body: any): VaniResponse => ({
  status: 202,
  body: { trigger_id: 'eb6a26492ada', event_id: body.event_id, call_id: 'f89d1ee47b1c', status: 'queued', disposition: 'dialed' },
});

describeDb('vani calls: queued with the alert, sent once', () => {
  let owner: DataSource;
  let app: DataSource;
  const SRC = 'ta-2.0';

  const asTenant = <R>(tenant: string, fn: (m: EntityManager) => Promise<R>) =>
    app.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn(m);
    });

  const alert = async (ext: string, severity = 'critical', tenant = 'usa-test'): Promise<AlertEvent> => {
    const [row] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ($1, gen_random_uuid(), 'Main bearing temperature rising', $2, $3, $4,
                 'Main bearing temperature up 9 degrees over 72 hours', '{}'::jsonb, 'open', now())
       RETURNING id`,
      [tenant, SRC, ext, severity],
    );
    return (await owner.getRepository(AlertEvent).findOneByOrFail({ id: row.id }));
  };

  const calls = (): Promise<any[]> => owner.query(`SELECT * FROM vani_call ORDER BY created_at, id`);
  const later = (minutes = 0) => new Date(Date.now() + 1_000 + minutes * 60_000);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client'), ('globex', 'Globex')`);
    for (const ext of ['DG-01', 'DG-02']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ('usa-test', $1, $2, $2, 'client', 'active', 'basic', '{}'::jsonb)`,
        [SRC, ext],
      );
    }
    await owner.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone, callback_url)
         VALUES ('usa-test', 'usa-test-01', '+12012031340', 'https://api.example.test/api/v1/vani/outcome-callback')`,
    );
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`,
      [SRC],
    );
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE vani_call_outcome, vani_call, alert_event CASCADE`);
    await owner.query(`UPDATE vani_account_link SET enabled = true`);
  });

  describe('queueing', () => {
    it('asks for a call about an alert on a linked machine, in the words Vani will use', async () => {
      const a = await alert('DG-01');
      expect(await asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]))).toBe(1);

      const [row] = await calls();
      expect(row).toMatchObject({ alert_event_id: a.id, vani_account_id: 'usa-test-01', machine_id: 'dg-01', severity: 'critical', state: 'pending' });
      expect(row.request).toEqual({
        event_id: a.id,
        account_id: 'usa-test-01',
        customer_phone: '+12012031340',
        machine: { machine_id: 'dg-01', name: 'Diesel Generator DG-01' },
        trigger: { kind: 'alert', severity: 'critical', title: 'Main bearing temperature rising', fired_at: a.firedAt.toISOString() },
        context: {
          alert_title: 'Main bearing temperature rising',
          summary: 'Main bearing temperature up 9 degrees over 72 hours',
        },
        callback_url: 'https://api.example.test/api/v1/vani/outcome-callback',
      });
    });

    it('asks nothing for a machine Vani does not know', async () => {
      const a = await alert('DG-02');
      expect(await asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]))).toBe(0);
      expect(await calls()).toEqual([]);
    });

    it('asks nothing while the account is switched off', async () => {
      await owner.query(`UPDATE vani_account_link SET enabled = false`);
      const a = await alert('DG-01');
      expect(await asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]))).toBe(0);
      expect(await calls()).toEqual([]);
    });

    it('asks once when the same alert is queued twice at the same moment', async () => {
      const a = await alert('DG-01');
      const both = await Promise.allSettled([
        asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a])),
        asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a])),
      ]);
      expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(both.map((r) => (r as PromiseFulfilledResult<number>).value).sort()).toEqual([0, 1]);
      expect(await calls()).toHaveLength(1);
    });

    it('a fault in queueing costs the call, never the alert\'s transaction', async () => {
      const bad = Object.assign(await alert('DG-01'), { severity: 'severe' as Severity });
      const good = await alert('DG-01');
      await asTenant('usa-test', async (m) => {
        expect(await queueVaniCalls(m, 'usa-test', [bad])).toBe(0);
        // The transaction is still usable afterwards: this is what the alert's own
        // writes would be doing next.
        expect(await queueVaniCalls(m, 'usa-test', [good])).toBe(1);
      });
      expect((await calls()).map((c) => c.alert_event_id)).toEqual([good.id]);
    });
  });

  describe('sending', () => {
    const queue = async (ext = 'DG-01', severity = 'critical') => {
      const a = await alert(ext, severity);
      await asTenant('usa-test', (m) => queueVaniCalls(m, 'usa-test', [a]));
      return a;
    };

    it('sends nothing, and spends nothing, until Vani is configured', async () => {
      await queue();
      const vani = new ScriptedVani(dialed);
      vani.configured = false;
      expect(await new VaniCallSender(app, vani).pass(later())).toEqual({ accepted: 0, rejected: 0, retried: 0, failed: 0 });
      expect(vani.sent).toEqual([]);
      expect((await calls())[0]).toMatchObject({ state: 'pending', attempts: 0 });
    });

    it('records the call Vani placed', async () => {
      const a = await queue();
      const vani = new ScriptedVani(dialed);
      expect((await new VaniCallSender(app, vani).pass(later())).accepted).toBe(1);
      expect(vani.sent).toHaveLength(1);
      expect(vani.sent[0].path).toBe('/platform/alert-call');
      expect(vani.sent[0].body.event_id).toBe(a.id);
      expect((await calls())[0]).toMatchObject({
        state: 'accepted', attempts: 1, http_status: 202, trigger_id: 'eb6a26492ada',
        call_id: 'f89d1ee47b1c', vani_status: 'queued', disposition: 'dialed',
      });
    });

    it('records a deferral, and leaves the dialling to Vani', async () => {
      await queue('DG-01', 'medium');
      const vani = new ScriptedVani((b) => ({
        status: 202,
        body: { trigger_id: 't2', event_id: b.event_id, call_id: null, status: 'deferred', disposition: 'deferred',
          reason: 'quiet hours', retry_at: '2026-11-05T14:00:00Z' },
      }));
      const sender = new VaniCallSender(app, vani);
      await sender.pass(later());
      await sender.pass(later(60 * 24));
      expect(vani.sent).toHaveLength(1);
      expect((await calls())[0]).toMatchObject({ state: 'accepted', call_id: null, disposition: 'deferred', reason: 'quiet hours' });
      expect((await calls())[0].retry_at.toISOString()).toBe('2026-11-05T14:00:00.000Z');
    });

    it('treats Vani\'s duplicate as the call it already placed', async () => {
      await queue();
      const vani = new ScriptedVani((b) => ({
        status: 200, body: { status: 'duplicate', event_id: b.event_id, call_id: 'f89d1ee47b1c', trigger_id: 'eb6a26492ada' },
      }));
      expect((await new VaniCallSender(app, vani).pass(later())).accepted).toBe(1);
      expect((await calls())[0]).toMatchObject({ state: 'accepted', http_status: 200, call_id: 'f89d1ee47b1c' });
    });

    it('stops at a refusal and never resends the same body', async () => {
      await queue();
      const vani = new ScriptedVani(() => ({ status: 422, body: { error: 'unknown account_id usa-test-01' } }));
      const sender = new VaniCallSender(app, vani);
      expect((await sender.pass(later())).rejected).toBe(1);
      await sender.pass(later(60));
      expect(vani.sent).toHaveLength(1);
      expect((await calls())[0]).toMatchObject({ state: 'rejected', reason: 'unknown account_id usa-test-01' });
    });

    it('retries an outage with the same body, after a wait', async () => {
      await queue();
      let n = 0;
      const vani = new ScriptedVani((b) => (n++ === 0 ? { status: 503, body: {} } : dialed(b)));
      const sender = new VaniCallSender(app, vani);
      const now = later();
      expect((await sender.pass(now)).retried).toBe(1);
      expect((await calls())[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Vani answered 503' });

      await sender.pass(now);
      expect(vani.sent).toHaveLength(1);

      expect((await sender.pass(new Date(now.getTime() + 61_000))).accepted).toBe(1);
      expect(vani.sent).toHaveLength(2);
      expect(vani.sent[1].body).toEqual(vani.sent[0].body);
    });

    it('retries when Vani cannot be reached at all', async () => {
      await queue();
      const vani = new ScriptedVani(() => { throw new Error('connect ECONNREFUSED'); });
      expect((await new VaniCallSender(app, vani).pass(later())).retried).toBe(1);
      expect((await calls())[0].last_error).toMatch(/could not be reached: connect ECONNREFUSED/);
    });

    it('says to check the token on a 401, without ending the request', async () => {
      await queue();
      const vani = new ScriptedVani(() => ({ status: 401, body: {} }));
      expect((await new VaniCallSender(app, vani).pass(later())).retried).toBe(1);
      expect((await calls())[0]).toMatchObject({ state: 'pending', last_error: expect.stringMatching(/VANI_PLATFORM_TOKEN/) });
    });

    it('gives up after the last attempt', async () => {
      await queue();
      const vani = new ScriptedVani(() => ({ status: 500, body: {} }));
      const sender = new VaniCallSender(app, vani);
      for (let i = 0; i < MAX_ATTEMPTS; i++) await sender.pass(later(60 * (i + 1)));
      expect(vani.sent).toHaveLength(MAX_ATTEMPTS);
      expect((await calls())[0]).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    });

    it('does not phone about an alert from yesterday', async () => {
      await queue();
      await owner.query(`UPDATE vani_call SET created_at = now() - interval '25 hours'`);
      const vani = new ScriptedVani(dialed);
      expect((await new VaniCallSender(app, vani).pass(later())).failed).toBe(1);
      expect(vani.sent).toEqual([]);
      expect((await calls())[0].last_error).toMatch(/expired/);
    });

    it('sends each request once when two senders run at the same moment', async () => {
      await queue();
      await queue();
      const vani = new ScriptedVani(async (b) => { await new Promise((r) => setTimeout(r, 50)); return dialed(b); });
      const settled = await Promise.allSettled([
        new VaniCallSender(app, vani).pass(later()),
        new VaniCallSender(app, vani).pass(later()),
      ]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(vani.sent).toHaveLength(2);
      expect(new Set(vani.sent.map((s) => s.body.event_id)).size).toBe(2);
      expect((await calls()).every((c) => c.state === 'accepted')).toBe(true);
    });
  });
});
