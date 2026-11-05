import { DataSource } from 'typeorm';
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, VaniBreaker } from '../src/vani/vani-breaker';
import { VaniCallSender } from '../src/vani/vani-call-sender';
import { VaniResponse, VaniTransport } from '../src/vani/vani-client';
import { VaniSnapshotPusher } from '../src/vani/vani-snapshot';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Leaving Vani alone while it is down.
 *
 * What an outage must not cost: a timeout per waiting request on every pass, and an
 * attempt from each request that never had a chance. What it must still allow: finding
 * out, one request at a time, that Vani is back.
 */
const at = (ms: number) => new Date(Date.UTC(2026, 10, 5, 12) + ms);

describe('vani breaker', () => {
  it('stays closed until failures run in a row, then holds everything for the cooldown', () => {
    const b = new VaniBreaker();
    for (let i = 1; i < BREAKER_THRESHOLD; i++) { b.failed(at(0)); expect(b.allows(at(0))).toBe(true); }
    b.failed(at(0));
    expect(b.state(at(0))).toBe('open');
    expect(b.allows(at(BREAKER_COOLDOWN_MS - 1))).toBe(false);
  });

  it('forgets earlier failures once Vani answers', () => {
    const b = new VaniBreaker();
    for (let i = 1; i < BREAKER_THRESHOLD; i++) b.failed(at(0));
    b.succeeded();
    b.failed(at(0));
    expect(b.state(at(0))).toBe('closed');
  });

  it('lets one probe through after the cooldown, and only one', () => {
    const b = new VaniBreaker(1, 1000);
    b.failed(at(0));
    expect(b.allows(at(1000))).toBe(true);
    expect(b.allows(at(1000))).toBe(false);
    b.succeeded();
    expect(b.state(at(1000))).toBe('closed');
  });

  it('opens again at once when the probe fails', () => {
    const b = new VaniBreaker(3, 1000);
    for (let i = 0; i < 3; i++) b.failed(at(0));
    expect(b.allows(at(1000))).toBe(true);
    b.failed(at(1000));
    expect(b.allows(at(1500))).toBe(false);
  });

  it('frees the probe when it went nowhere near Vani', () => {
    const b = new VaniBreaker(1, 1000);
    b.failed(at(0));
    expect(b.allows(at(1000))).toBe(true);
    b.release();
    expect(b.allows(at(1000))).toBe(true);
  });

  it('counts an unwell answer as a failure, and a refusal of the payload as Vani being up', () => {
    expect([500, 503, 429, 401].every(VaniBreaker.isFailure)).toBe(true);
    expect([200, 202, 400, 404, 422].some(VaniBreaker.isFailure)).toBe(false);
  });
});

/** A Vani whose health the test decides, and which counts what reached it. */
class SwitchableVani implements VaniTransport {
  configured = true;
  sent: string[] = [];
  mode: 'down' | '503' | 'up' | '422' = 'down';
  async post(path: string, body: any): Promise<VaniResponse> {
    this.sent.push(path);
    if (this.mode === 'down') throw new Error('connect ECONNREFUSED');
    if (this.mode === '503') return { status: 503, body: { error: 'unavailable' } };
    if (this.mode === '422') return { status: 422, body: { error: 'customer_phone not registered' } };
    return path.endsWith('alert-call')
      ? { status: 202, body: { event_id: body.event_id, status: 'queued', disposition: 'dialed' } }
      : { status: 200, body: { status: 'ok' } };
  }
}

describeDb('vani breaker: an outage holds the sender and the snapshots', () => {
  let owner: DataSource;
  let app: DataSource;
  const SRC = 'ta-2.0';
  const calls = (): Promise<{ state: string; attempts: number }[]> =>
    owner.query(`SELECT state, attempts FROM vani_call ORDER BY created_at, id`);

  /** Three due requests, queued a moment before `at(0)`. */
  const queueThree = async () => {
    for (let i = 0; i < 3; i++) {
      const [a] = await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
           VALUES ('usa-test', gen_random_uuid(), 'Bearing vibration high', $1, 'DG-01', 'critical', 's', '{}'::jsonb, 'open', $2)
         RETURNING id`, [SRC, at(-60_000)]);
      await owner.query(
        `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request, created_at, next_attempt_at)
           VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'critical', '{}'::jsonb, $2, $2)`, [a.id, at(-60_000 + i)]);
    }
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('usa-test', $1, 'DG-01', 'DG-01', 'client', 'active', 'basic', '{}'::jsonb)`, [SRC]);
    await owner.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone) VALUES ('usa-test', 'usa-test-01', '+12012031340')`);
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`, [SRC]);
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE vani_call_outcome, vani_call, alert_event CASCADE`);
    await owner.query(`UPDATE vani_account_link SET snapshot_hash = NULL, snapshot_error = NULL, snapshot_attempted_at = NULL`);
  });

  it('stops a pass at the first failure, leaving the other requests their attempts', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    const r = await new VaniCallSender(app, vani, new VaniBreaker()).pass(at(0));

    expect(vani.sent).toHaveLength(1);
    expect(r).toEqual({ accepted: 0, rejected: 0, retried: 1, failed: 0 });
    expect((await calls()).map((c) => c.attempts)).toEqual([1, 0, 0]);
  });

  it('once open, contacts nothing and claims nothing until the cooldown is over', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    vani.mode = '503';
    const breaker = new VaniBreaker();
    const sender = new VaniCallSender(app, vani, breaker);
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await sender.pass(at(i * 1000));
    expect(breaker.state(at(BREAKER_THRESHOLD * 1000))).toBe('open');
    const before = await calls();

    vani.sent = [];
    const held = await sender.pass(at(BREAKER_THRESHOLD * 1000));
    expect(vani.sent).toEqual([]);
    expect(held).toEqual({ accepted: 0, rejected: 0, retried: 0, failed: 0 });
    expect(await calls()).toEqual(before);
  });

  it('after the cooldown, a probe that gets through lets the rest of the pass go', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    const breaker = new VaniBreaker(1, 1000);
    const sender = new VaniCallSender(app, vani, breaker);
    await sender.pass(at(0));
    expect(breaker.state(at(0))).toBe('open');

    vani.mode = 'up';
    // Past the first request's own one-minute backoff, so all three are due.
    const r = await sender.pass(at(2 * 60_000));
    expect(r.accepted).toBe(3);
    expect(breaker.state(at(2 * 60_000))).toBe('closed');
  });

  it('does not treat a refused payload as an outage', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    vani.mode = '422';
    const breaker = new VaniBreaker(1, 1000);
    const r = await new VaniCallSender(app, vani, breaker).pass(at(0));
    expect(r.rejected).toBe(3);
    expect(breaker.state(at(0))).toBe('closed');
  });

  it('holds the snapshots too when the sender found Vani down', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    const breaker = new VaniBreaker(1, 60_000);
    await new VaniCallSender(app, vani, breaker).pass(at(0));
    vani.sent = [];

    const s = await new VaniSnapshotPusher(app, vani, breaker).pass(at(1000));
    expect(vani.sent).toEqual([]);
    expect(s).toEqual({ pushed: 0, unchanged: 0, refused: 0, failed: 0 });
  });

  it('opens on snapshot failures as well, and the sender then waits', async () => {
    await queueThree();
    const vani = new SwitchableVani();
    const breaker = new VaniBreaker(1, 60_000);
    await new VaniSnapshotPusher(app, vani, breaker).pass(at(0));
    expect(breaker.state(at(0))).toBe('open');
    vani.sent = [];

    await new VaniCallSender(app, vani, breaker).pass(at(1000));
    expect(vani.sent).toEqual([]);
    expect((await calls()).map((c) => c.attempts)).toEqual([0, 0, 0]);
  });
});
