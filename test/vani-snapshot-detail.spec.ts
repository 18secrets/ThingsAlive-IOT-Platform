import { DataSource } from 'typeorm';
import { VaniResponse, VaniTransport } from '../src/vani/vani-client';
import { VaniSnapshotPusher } from '../src/vani/vani-snapshot';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The fuller account snapshot (D57, Lane C): each machine's recent alerts and what
 * became of them, its open jobs, and the predictions saying something — so Vani can
 * walk an account with a customer before they ask anything.
 *
 * Off unless `VANI_SNAPSHOT_DETAIL=true`, and the first thing proved is that off means
 * byte-for-byte the snapshot Vani already accepts: Vani may refuse fields it does not
 * read yet, and a refused snapshot is no snapshot at all.
 */
class ScriptedVani implements VaniTransport {
  configured = true;
  sent: { path: string; body: any }[] = [];
  async post(path: string, body: any): Promise<VaniResponse> {
    this.sent.push({ path, body });
    return { status: 200, body: { ok: true } };
  }
}

const SRC = 'ta-2.0';
const ON = { VANI_SNAPSHOT_DETAIL: 'true' };
const NOW = new Date('2026-11-06T18:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describeDb('vani: the fuller account snapshot', () => {
  let owner: DataSource;
  let appDs: DataSource;

  const alert = (ext: string, name: string, firedAt: Date, state = 'open', note: string | null = null) => owner.query(
    `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at,
                              resolved_by, resolved_at, resolution_note)
       VALUES ('usa-test', gen_random_uuid(), $1, $2, $3, 'high', 's', '{}'::jsonb, $4, $5, $6, $7, $8)`,
    [name, SRC, ext, state, firedAt, state === 'resolved' ? 'deepak' : null, state === 'resolved' ? firedAt : null, note]);
  const job = (ext: string, ref: string, status: string, dueAt: Date | null = null) => owner.query(
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, status, priority, origin, raised_by, due_at,
                             resolution)
       VALUES ('usa-test', $1, $2, $3, $4, $5, 'normal', 'manual', 'deepak', $6, $7)`,
    // A completed job must say how (ck_work_order_resolution).
    [ref, SRC, ext, `Job ${ref}`, status, dueAt, status === 'completed' ? 'Done' : null]);
  const scored = (ext: string, slug: string, severity: string, at: Date, over: { confidence?: string; source?: string; risk?: number } = {}) =>
    owner.query(
      `INSERT INTO prediction (tenant_id, source_system, external_id, client_scenario_slug, severity, risk_score, confidence,
                               window_days, occurred_at, source)
         VALUES ('usa-test', $1, $2, $3, $4, $5, $6, 7, $7, $8)`,
      [SRC, ext, slug, severity, over.risk ?? 64.6, over.confidence ?? 'full', at, over.source ?? 'live']);
  const push = async (env: NodeJS.ProcessEnv = ON) => {
    const vani = new ScriptedVani();
    const result = await new VaniSnapshotPusher(appDs, vani, undefined, env).pass(NOW);
    return { result, body: vani.sent[0]?.body };
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    appDs = await createAppDataSource();
    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client')`);
    for (const ext of ['DG-01', 'DG-02']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ('usa-test', $1, $2, $2, 'client', 'active', 'basic', '{}'::jsonb)`, [SRC, ext]);
    }
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    await owner.query(`INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
      VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`, [SRC]);
  }, 60_000);

  afterAll(async () => { await appDs?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM alert_event`);
    await owner.query(`DELETE FROM work_order`);
    await owner.query(`DELETE FROM prediction`);
    await owner.query(`UPDATE vani_account_link SET snapshot_hash = NULL, snapshot_refused_hash = NULL,
      snapshot_error = NULL, snapshot_attempted_at = NULL, snapshot_pushed_at = NULL`);
  });

  it('sends exactly today\'s snapshot while the switch is off', async () => {
    await alert('DG-01', 'Bearing vibration high', daysAgo(1));
    await job('DG-01', 'WO-1', 'created');
    await scored('DG-01', 'bearing-wear', 'high', daysAgo(1));
    const { body } = await push({});
    expect(body.machines).toEqual([
      { machine_id: 'dg-01', name: 'Diesel Generator DG-01', status: 'One open alert: Bearing vibration high' },
    ]);
  });

  it('adds recent alerts and what became of them, newest first, at most five', async () => {
    await alert('DG-01', 'Old news', daysAgo(40));
    await alert('DG-01', 'Low fuel', daysAgo(3), 'resolved', 'Refuelled on site');
    for (let i = 0; i < 5; i += 1) await alert('DG-01', `Spike ${i}`, daysAgo(2 - i * 0.1));
    const { body } = await push();
    const recent = body.machines[0].recent_alerts;
    expect(recent).toHaveLength(5);
    expect(recent[0]).toEqual({ title: 'Spike 4', severity: 'high', state: 'open', fired_at: daysAgo(1.6).toISOString() });
    expect(recent.map((a: any) => a.title)).not.toContain('Old news');
  });

  it('says how a resolved alert was dealt with', async () => {
    await alert('DG-01', 'Low fuel', daysAgo(3), 'resolved', 'Refuelled on site');
    const { body } = await push();
    expect(body.machines[0].recent_alerts).toEqual([{
      title: 'Low fuel', severity: 'high', state: 'resolved', fired_at: daysAgo(3).toISOString(), resolution: 'Refuelled on site',
    }]);
  });

  it('lists the jobs still to do, soonest due first, and not finished ones', async () => {
    await job('DG-01', 'WO-3', 'in-progress');
    await job('DG-01', 'WO-2', 'created', new Date('2026-11-10T00:00:00Z'));
    await job('DG-01', 'WO-1', 'completed');
    await job('DG-01', 'WO-4', 'cancelled');
    const { body } = await push();
    expect(body.machines[0].open_work_orders).toEqual([
      { reference: 'WO-2', title: 'Job WO-2', status: 'created', due_at: '2026-11-10T00:00:00.000Z' },
      { reference: 'WO-3', title: 'Job WO-3', status: 'in-progress' },
    ]);
  });

  it('gives each scenario\'s latest live score, when it says something', async () => {
    await scored('DG-01', 'bearing-wear', 'medium', daysAgo(2));
    await scored('DG-01', 'bearing-wear', 'critical', daysAgo(1), { risk: 88.2 });
    await scored('DG-01', 'oil-temp', 'high', daysAgo(1), { confidence: 'partial' });
    await scored('DG-01', 'coolant', 'low', daysAgo(1));
    await scored('DG-01', 'fuel-leak', 'high', daysAgo(1), { confidence: 'none' });
    await scored('DG-01', 'replayed-one', 'critical', daysAgo(1), { source: 'replayed' });
    await scored('DG-01', 'stale', 'critical', daysAgo(10));
    // Latest is calm: the scenario has nothing to say now, even though it did yesterday.
    await scored('DG-01', 'belt', 'high', daysAgo(2));
    await scored('DG-01', 'belt', 'none', daysAgo(1));
    const { body } = await push();
    expect(body.machines[0].open_predictions).toEqual([
      { scenario: 'bearing wear', severity: 'critical', risk_score: 88, confidence: 'full', scored_at: daysAgo(1).toISOString() },
      { scenario: 'oil temp', severity: 'high', risk_score: 65, confidence: 'partial', scored_at: daysAgo(1).toISOString() },
    ]);
  });

  it('says nothing about a machine Vani does not know', async () => {
    await alert('DG-02', 'Not linked', daysAgo(1));
    await job('DG-02', 'WO-9', 'created');
    await scored('DG-02', 'bearing-wear', 'critical', daysAgo(1));
    const { body } = await push();
    expect(JSON.stringify(body)).not.toMatch(/Not linked|WO-9/);
    expect(body.machines.map((m: any) => m.machine_id)).toEqual(['dg-01']);
  });

  it('pushes again when the detail changes, and not when it does not', async () => {
    expect((await push()).result.pushed).toBe(1);
    expect((await push()).result.unchanged).toBe(1);
    await job('DG-01', 'WO-5', 'created');
    expect((await push()).result.pushed).toBe(1);
  });

  it('pushes the fuller picture as soon as the switch is turned on', async () => {
    expect((await push({})).result.pushed).toBe(1);
    expect((await push(ON)).result.pushed).toBe(1);
  });
});
