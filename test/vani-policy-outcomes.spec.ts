import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * The outcomes Vani reports for a trigger it accepted and chose not to dial
 * (`1763900000000-VaniPolicyOutcomes.ts`, Machine Lane Spec §3.4).
 *
 * Since the four-lane scope, a feature switched off for an account comes back as
 * `suppressed_by_policy` / `feature_not_enabled`. Refused, those callbacks would leave
 * the alert history silent about the calls a customer most wants explained — so this
 * goes through the real route, as Vani does, and the refusals that still matter are
 * asserted by attempting them.
 */
const MIGRATION = 'VaniPolicyOutcomes1763900000000';
const CALLBACK_SECRET = 'shared-with-vani';
const SRC = 'ta-2.0';

describeDb('vani: outcomes for calls policy did not place', () => {
  let owner: DataSource;
  let app: INestApplication;
  let alertId: string;

  const outcomeBody = (over: Record<string, unknown> = {}) => ({
    event_id: alertId,
    call_id: 'c-suppressed-1',
    account_id: 'usa-test-01',
    machine_id: 'dg-01',
    outcome: 'suppressed_by_policy',
    reason: 'feature_not_enabled',
    summary: 'Not called: predictions are not enabled for this account.',
    attempt: 0,
    ...over,
  });
  const postOutcome = (body: unknown) => request(app.getHttpServer())
    .post('/api/v1/vani/outcome-callback').set('X-Vani-Secret', CALLBACK_SECRET).send(body as object);
  const outcomes = (): Promise<any[]> =>
    owner.query(`SELECT attempt, outcome, payload FROM vani_call_outcome ORDER BY attempt`);
  const insertOutcome = (outcome: string, attempt: number) => owner.query(
    `INSERT INTO vani_call_outcome (tenant_id, alert_event_id, attempt, outcome, payload)
       VALUES ('usa-test', $1, $2, $3, '{}'::jsonb)`, [alertId, attempt, outcome]);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-vani-policy-outcomes';
    process.env.AUTH_JWT_ISSUER = 'things-alive-vani-policy-outcomes-test';
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
    const [a] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('usa-test', gen_random_uuid(), 'Bearing failure risk rising', $1, 'DG-01', 'high', 's', '{}'::jsonb, 'open', now())
       RETURNING id`, [SRC]);
    alertId = a.id;
    await owner.query(
      `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request, state, call_id, disposition)
         VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'warning', '{}'::jsonb, 'accepted', 'c-suppressed-1', 'suppressed')`,
      [alertId]);
  }, 60_000);

  afterAll(async () => {
    delete process.env.VANI_CALLBACK_SECRET;
    await app?.close(); await owner?.destroy();
  });

  beforeEach(() => owner.query(`DELETE FROM vani_call_outcome`));

  it('records a call suppressed by policy, keeping the reason Vani gave', async () => {
    const res = await postOutcome(outcomeBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: false });
    const [row] = await outcomes();
    expect(row.outcome).toBe('suppressed_by_policy');
    // The reason is not a column; it is kept as Vani sent it, so nothing is lost.
    expect(row.payload.reason).toBe('feature_not_enabled');
  });

  it('records a call held for the customer’s next inbound review', async () => {
    expect((await postOutcome(outcomeBody({ outcome: 'held_for_inbound_review', reason: 'quiet_hours' }))).status).toBe(200);
    expect((await outcomes()).map((o) => o.outcome)).toEqual(['held_for_inbound_review']);
  });

  it('writes once when the same suppressed callback arrives twice at the same moment', async () => {
    const both = await Promise.allSettled([postOutcome(outcomeBody()), postOutcome(outcomeBody())]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(both.map((r) => (r as PromiseFulfilledResult<request.Response>).value.status)).toEqual([200, 200]);
    expect(await outcomes()).toHaveLength(1);
  });

  it('still refuses an outcome Vani does not send, in the service and in the database', async () => {
    expect((await postOutcome(outcomeBody({ outcome: 'not_called' }))).status).toBe(400);
    await expect(insertOutcome('not_called', 1)).rejects.toThrow(/ck_vani_call_outcome_outcome/);
    expect(await outcomes()).toEqual([]);
  });

  describe('the migration', () => {
    it('will not roll back over a stored outcome it would no longer allow', async () => {
      await insertOutcome('suppressed_by_policy', 0);
      await expect(undoMigrationNamed(owner, MIGRATION)).rejects.toThrow(/ck_vani_call_outcome_outcome/);
      // Still applied, and the outcome is still there.
      const [{ name }] = await owner.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
      expect(name).toBe(MIGRATION);
      expect((await outcomes()).map((o) => o.outcome)).toEqual(['suppressed_by_policy']);
    });

    it('has a down path that puts the five outcomes back', async () => {
      // Named, not undoLastMigration(): "last" stops meaning this one when another lands.
      await undoMigrationNamed(owner, MIGRATION);
      await expect(insertOutcome('suppressed_by_policy', 0)).rejects.toThrow(/ck_vani_call_outcome_outcome/);
      await insertOutcome('no_answer', 1);
      await owner.query(`DELETE FROM vani_call_outcome`);

      await owner.runMigrations({ transaction: 'all' });
      await insertOutcome('suppressed_by_policy', 0);
    });
  });
});
