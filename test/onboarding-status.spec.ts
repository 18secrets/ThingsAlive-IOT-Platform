import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource, QueryRunner } from 'typeorm';
import { ActivationService } from '../src/activation/services/activation.service';
import { AlertService } from '../src/alert/services/alert.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { DEMO_MACHINES, DEMO_SOURCE, DEMO_TENANT, imeiOf, seedDemo } from '../src/database/seeds/seed-demo';
import { UserService } from '../src/identity/services/user.service';
import { InventoryService } from '../src/inventory/services/inventory.service';
import { createApp } from '../src/main';
import { MachineOnboarding, OnboardingStatusService, StepName } from '../src/onboarding/onboarding-status.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-onboarding-status';
const ISSUER = 'things-alive-onboarding-status-test';
/** The demo seed's instant: mid-shift, so EX-04 is three days quiet and the rest fresh. */
const NOW = new Date('2026-10-06T07:00:00.000Z');
const ENABLED = { SEED_DEMO_ENABLED: 'true' } as NodeJS.ProcessEnv;

const demo: RequestScope = { tenantId: DEMO_TENANT, userId: 'u-demo', roles: ['super admin'], isPlatformRole: false };
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

const stepOf = (m: MachineOnboarding, name: StepName) => m.steps.find((s) => s.step === name)!;
const states = (m: MachineOnboarding) => Object.fromEntries(m.steps.map((s) => [s.step, s.state]));

/**
 * Onboarding status (task QONBOARD-STATUS), read off the demo tenant: six machines in
 * six states, with devices, bindings, readings and an alert rule already in place. Each
 * step is moved through the service that owns it — claim, activate, invite, disable —
 * never by writing the row the step reads, so the test proves the step follows the
 * fact rather than a fixture shaped like one.
 */
describeDb('onboarding status', () => {
  let owner: DataSource;
  let app: INestApplication;
  let status: OnboardingStatusService;

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
    status = app.get(OnboardingStatusService);
    await seedDemo(owner, { now: NOW, env: ENABLED });
  }, 180_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const machine = (externalId: string) => status.machine(demo, DEMO_SOURCE, externalId, NOW);

  // ================================================================ the fleet
  it('the demo site: six machines in progress, each step counted; the empty site is no_equipment, not completed', async () => {
    const { sites } = await status.summary(demo, NOW);
    const pune1 = sites.find((s) => s.site?.code === 'PUNE-01')!;
    const pune2 = sites.find((s) => s.site?.code === 'PUNE-02')!;

    expect(pune1.machines).toEqual({ total: 6, done: 0, inProgress: 6 });
    expect(pune1.status).toBe('in_progress');
    expect(pune1.steps.equipment).toEqual({ done: 6, pending: 0, blocked: 0 });
    expect(pune1.steps.device).toEqual({ done: 6, pending: 0, blocked: 0 });
    // EX-06 is partly unbound.
    expect(pune1.steps.mapping).toEqual({ done: 5, pending: 1, blocked: 0 });
    // EX-04 is stale; EX-06 waits on its mapping.
    expect(pune1.steps.validation).toEqual({ done: 4, pending: 1, blocked: 1 });
    // Nothing is activated and nobody holds a grant in the seed.
    expect(pune1.steps.activation).toEqual({ done: 0, pending: 5, blocked: 1 });
    expect(pune1.steps.access).toEqual({ done: 0, pending: 6, blocked: 0 });
    expect(pune1.steps.alerts).toEqual({ done: 6, pending: 0, blocked: 0 });

    expect(pune2).toEqual(expect.objectContaining({ status: 'no_equipment', machines: { total: 0, done: 0, inProgress: 0 } }));
  });

  it('an unbound signal: mapping pending with coverage\'s reason and the signals named; what waits on it says so', async () => {
    const ex06 = await machine('EX-06');
    const unbound = DEMO_MACHINES.find((m) => m.externalId === 'EX-06')!.unbound;
    expect(stepOf(ex06, 'mapping')).toEqual(expect.objectContaining({
      state: 'pending', reason: 'unbound', blockedBy: null,
      evidence: expect.objectContaining({ unbound: expect.arrayContaining([...unbound]) }),
    }));
    expect(stepOf(ex06, 'validation')).toEqual(expect.objectContaining({ state: 'blocked', reason: 'blocked_by_step', blockedBy: 'mapping' }));
    expect(stepOf(ex06, 'activation')).toEqual(expect.objectContaining({ state: 'blocked', blockedBy: 'mapping' }));
  });

  it('a machine gone quiet: validation pending with reason stale — not no_readings — and the stale signals listed', async () => {
    const ex04 = await machine('EX-04');
    const v = stepOf(ex04, 'validation');
    expect(v.state).toBe('pending');
    expect(v.reason).toBe('stale');
    expect((v.evidence.stale as string[]).length).toBeGreaterThan(0);
    expect(v.evidence.noReadings).toEqual([]);
  });

  // ================================================================== a walk
  it('EX-01 walked to done: activating and granting access each move exactly their own step', async () => {
    const before = await machine('EX-01');
    expect(states(before)).toEqual({
      equipment: 'done', device: 'done', mapping: 'done', validation: 'done',
      activation: 'pending', alerts: 'done', access: 'pending',
    });

    await app.get(ActivationService).apply(demo, 'activate', {
      sourceSystem: DEMO_SOURCE, externalId: 'EX-01', clientScenarioSlug: 'demo-excavator-coolant-drift',
    }, {}, NOW);
    const activated = await machine('EX-01');
    expect(states(activated)).toEqual({ ...states(before), activation: 'done' });

    await app.get(UserService).invite(demo, {
      email: 'operator-ex01@demo-construction.example', fullName: 'EX-01 Operator', roleSlug: 'operator',
      equipment: [{ sourceSystem: DEMO_SOURCE, equipmentExternalId: 'EX-01' }],
    }, NOW);
    const granted = await machine('EX-01');
    expect(states(granted)).toEqual({ ...states(activated), access: 'done' });
    expect(stepOf(granted, 'access').evidence).toEqual({ usersByEquipmentGrant: 1, usersBySiteGrant: 0 });
    expect(granted.overall).toBe('done');
  });

  it('progress is derived, so it goes backwards: releasing the device pends it and blocks what needs one', async () => {
    const before = await machine('EX-02');
    expect(stepOf(before, 'device').state).toBe('done');

    const ex02 = DEMO_MACHINES.find((m) => m.externalId === 'EX-02')!;
    await app.get(InventoryService).unclaim(demo, imeiOf(ex02), 'onboarding-status test', NOW);
    const after = await machine('EX-02');
    expect(stepOf(after, 'device')).toEqual(expect.objectContaining({ state: 'pending', reason: 'no_device_claimed' }));
    expect(stepOf(after, 'mapping')).toEqual(expect.objectContaining({ state: 'blocked', blockedBy: 'device' }));
    expect(stepOf(after, 'validation')).toEqual(expect.objectContaining({ state: 'blocked', blockedBy: 'mapping' }));

    // Fitting it again: device done, and mapping is no longer blocked.
    await app.get(InventoryService).claim(demo, imeiOf(ex02), 'EX-02', DEMO_SOURCE, NOW);
    const refitted = await machine('EX-02');
    expect(states(refitted)).toEqual(states(before));
  });

  it('a blocked step whose blocker is fixed turns pending, not done', async () => {
    const ex06 = DEMO_MACHINES.find((m) => m.externalId === 'EX-06')!;
    await app.get(InventoryService).unclaim(demo, imeiOf(ex06), 'onboarding-status test', NOW);
    // Device gone: mapping waits on it rather than reporting its own unbound signals.
    expect(stepOf(await machine('EX-06'), 'mapping')).toEqual(expect.objectContaining({ state: 'blocked', blockedBy: 'device' }));
    await app.get(InventoryService).claim(demo, imeiOf(ex06), 'EX-06', DEMO_SOURCE, NOW);
    // Blocker fixed: mapping is now its own problem — pending, still unbound, not done.
    expect(stepOf(await machine('EX-06'), 'mapping')).toEqual(expect.objectContaining({ state: 'pending', reason: 'unbound' }));
  });

  it('disabling the only rule that covers the machines pends alerts on all of them', async () => {
    const alerts = app.get(AlertService);
    const rules = await alerts.listRules(demo);
    const enabled = rules.filter((r) => r.enabled);
    for (const r of enabled) await alerts.setEnabled(demo, r.id, false);
    try {
      const ex03 = await machine('EX-03');
      expect(stepOf(ex03, 'alerts')).toEqual(expect.objectContaining({ state: 'pending', reason: 'no_alert_rule' }));
    } finally {
      for (const r of enabled) await alerts.setEnabled(demo, r.id, true);
    }
    expect(stepOf(await machine('EX-03'), 'alerts').state).toBe('done');
  });

  it('a rule on a signal the machine has not bound covers it but does not make alerts done', async () => {
    // Test report OB-5: an account-wide rule marked the step done on machines it could
    // never fire on. Leave only such a rule enabled and the step must stay pending.
    const alerts = app.get(AlertService);
    const enabled = (await alerts.listRules(demo)).filter((r) => r.enabled);
    for (const r of enabled) await alerts.setEnabled(demo, r.id, false);
    const unbound = await alerts.createRule(demo, {
      slug: 'turbo-boost-high', name: 'Turbo boost above 3', trigger: 'signal-threshold',
      params: { signal: 'turbo_boost_pressure', max: 3 }, appliesTo: 'account', severity: 'high',
    } as Parameters<AlertService['createRule']>[1]);
    try {
      expect(stepOf(await machine('EX-03'), 'alerts')).toEqual(expect.objectContaining({
        state: 'pending', reason: 'alert_signal_unbound',
        evidence: expect.objectContaining({ waitingOnSignals: ['turbo_boost_pressure'] }),
      }));
    } finally {
      await alerts.setEnabled(demo, unbound.id, false);
      for (const r of enabled) await alerts.setEnabled(demo, r.id, true);
    }
  });

  // ============================================================ edge cases
  it('an unclassified machine with no site: equipment pending, mapping waits on it, and it is listed under site null', async () => {
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by, name)
         VALUES ($1, $2, 'EX-99', 'standard', '{}'::jsonb, 'u', 'EX-99 Unclassified')`,
      [DEMO_TENANT, DEMO_SOURCE],
    );
    try {
      const ex99 = await machine('EX-99');
      expect(stepOf(ex99, 'equipment')).toEqual(expect.objectContaining({ state: 'pending', reason: 'unclassified' }));
      expect(stepOf(ex99, 'mapping')).toEqual(expect.objectContaining({ state: 'blocked', blockedBy: 'equipment' }));

      const noSite = (await status.summary(demo, NOW)).sites.find((s) => s.site === null)!;
      expect(noSite.machines).toEqual({ total: 1, done: 0, inProgress: 1 });
    } finally {
      await owner.query(`DELETE FROM equipment_profile WHERE tenant_id = $1 AND external_id = 'EX-99'`, [DEMO_TENANT]);
    }
  });

  it('another tenant\'s machines, devices, rules and users never count — even under the same external id', async () => {
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, updated_by, name)
         VALUES ('acme', $1, 'EX-05', NULL, NULL, 'standard', '{}'::jsonb, 'u', 'Acme EX-05')`,
      [DEMO_SOURCE],
    );
    const [user] = await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', 'x@acme.test', 'X', 'operator', 'active') RETURNING id`,
    );
    await owner.query(
      `INSERT INTO user_equipment_access (tenant_id, user_id, source_system, equipment_external_id) VALUES ('acme', $1, $2, 'EX-05')`,
      [user.id, DEMO_SOURCE],
    );
    try {
      // Acme's grant on its own EX-05 does not give the demo's EX-05 access.
      expect(stepOf(await machine('EX-05'), 'access').state).toBe('pending');
      // And acme sees its one machine, none of the demo's devices or rules.
      const { sites } = await status.summary(acme, NOW);
      expect(sites).toHaveLength(1);
      expect(sites[0].site).toBeNull();
      expect(sites[0].steps.device).toEqual({ done: 0, pending: 1, blocked: 0 });
      expect(sites[0].steps.alerts).toEqual({ done: 0, pending: 1, blocked: 0 });
      expect(sites[0].steps.access).toEqual({ done: 1, pending: 0, blocked: 0 });
    } finally {
      await owner.query(`DELETE FROM user_equipment_access WHERE tenant_id = 'acme'`);
      await owner.query(`DELETE FROM app_user WHERE tenant_id = 'acme'`);
      await owner.query(`DELETE FROM equipment_profile WHERE tenant_id = 'acme'`);
    }
  });

  it('a caller scoped to one machine sees that machine only, and a 404 for the rest', async () => {
    const operator: RequestScope = { ...demo, equipmentIds: ['EX-01'] };
    const { sites } = await status.summary(operator, NOW);
    expect(sites.reduce((n, s) => n + s.machines.total, 0)).toBe(1);
    await expect(status.machine(operator, DEMO_SOURCE, 'EX-02', NOW)).rejects.toThrow(/No such machine/);
  });

  // ================================================================== cost
  it('the summary reads in a fixed number of queries however many machines — coverage aside, once per machine', async () => {
    const bindings = app.get(SignalBindingService);
    const coverage = jest.spyOn(bindings, 'coverage').mockResolvedValue({
      equipment: { sourceSystem: DEMO_SOURCE, externalId: 'x' }, at: NOW.toISOString(), covered: [], missing: [], blockedLayers: [],
    });
    const runner = Object.getPrototypeOf(owner.createQueryRunner()) as QueryRunner;
    const query = jest.spyOn(runner, 'query');
    try {
      query.mockClear();
      await status.summary(demo, NOW);
      const small = query.mock.calls.length;
      // A spy that saw nothing would make the equality below vacuous.
      expect(small).toBeGreaterThan(0);
      const smallCoverage = coverage.mock.calls.length;

      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, updated_by, name)
           SELECT $1, $2, 'BULK-' || g, 'demo-excavator', 1, 'standard', '{}'::jsonb, 'u', 'Bulk ' || g FROM generate_series(1, 44) AS g`,
        [DEMO_TENANT, DEMO_SOURCE],
      );
      coverage.mockClear();
      query.mockClear();
      await status.summary(demo, NOW);
      expect(query.mock.calls.length).toBe(small);
      expect(smallCoverage).toBe(6);
      expect(coverage.mock.calls.length).toBe(50);
    } finally {
      query.mockRestore();
      coverage.mockRestore();
      await owner.query(`DELETE FROM equipment_profile WHERE tenant_id = $1 AND external_id LIKE 'BULK-%'`, [DEMO_TENANT]);
    }
  });

  // ==================================================================== HTTP
  const bearer = (roles: string[]) => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000a1', client_id: DEMO_TENANT, roles }, { secret: SECRET, issuer: ISSUER },
  );

  it('equipment.write reads both routes; a role without it is refused', async () => {
    const server = app.getHttpServer();
    const admin = await bearer(['admin']);
    const summary = await request(server).get('/api/v1/onboarding/status').set('Authorization', `Bearer ${admin}`);
    expect(summary.status).toBe(200);
    expect(summary.body.sites.map((s: { site: { code: string } | null }) => s.site?.code)).toEqual(['PUNE-01', 'PUNE-02']);
    const one = await request(server).get(`/api/v1/onboarding/status/equipment/${DEMO_SOURCE}/EX-06`).set('Authorization', `Bearer ${admin}`);
    expect(one.status).toBe(200);
    expect(one.body.steps).toHaveLength(7);

    const operator = await bearer(['operational']);
    expect((await request(server).get('/api/v1/onboarding/status').set('Authorization', `Bearer ${operator}`)).status).toBe(403);
  });
});
