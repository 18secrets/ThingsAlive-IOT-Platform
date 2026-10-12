import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { EvidenceInput, ShieldService } from '../src/shield/shield.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SECRET = 'test-secret-shield-evidence';
const ISSUER = 'things-alive-shield-evidence-test';
const SS = 'iot-platform-1';
const NOW = new Date('2026-10-12T12:00:00.000Z');
const daysFrom = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };

const passed = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  title: 'Guard / isolation inspection', result: 'passed', performedAt: daysFrom(-10),
  dueAt: daysFrom(90), ownerName: 'Maintenance lead', ...over,
});

/**
 * ThingsShield evidence (task QSHIELD1). Every refusal here is attempted, not looked
 * up: the record is updated, deleted, revised twice, read across tenants — and the
 * database or the service is expected to say no.
 */
describeDb('ThingsShield evidence', () => {
  let owner: DataSource;
  let appDs: DataSource;
  let app: INestApplication;
  let shield: ShieldService;

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
    shield = app.get(ShieldService);
    appDs = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await app?.close(); await appDs?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "shield_evidence_record", "tenant_parameter", "app_user", "equipment_profile", "plant" RESTART IDENTITY CASCADE`);
  });

  // ============================================================== fixtures
  const seedMachine = async (tenant: string, externalId: string, plantId: string | null = null) => {
    const [row] = await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, tier, readiness, updated_by, name, plant_id)
         VALUES ($1, $2, $3, 'dg', 1, 'standard', '{}'::jsonb, 'u', $4, $5) RETURNING id`,
      [tenant, SS, externalId, `Machine ${externalId}`, plantId],
    );
    return row.id as string;
  };

  const seedUser = async (tenant: string, email: string) => {
    const [row] = await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ($1, $2, 'Owner', 'operator', 'active') RETURNING id`,
      [tenant, email],
    );
    return row.id as string;
  };

  /** A tenant session as the running service holds one: `ta_app`, tenant set, no bypass. */
  const asApp = <R>(tenant: string, fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<R>) =>
    appDs.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn((sql, params) => m.query(sql, params));
    });

  // ========================================================== immutability
  it('a record cannot be updated or deleted — not by the app role, not by the owner', async () => {
    await seedMachine('acme', 'DG-1');
    const rec = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);

    await expect(asApp('acme', (q) => q(`UPDATE shield_evidence_record SET result = 'failed' WHERE id = $1`, [rec.id])))
      .rejects.toThrow(/permission denied/);
    await expect(asApp('acme', (q) => q(`DELETE FROM shield_evidence_record WHERE id = $1`, [rec.id])))
      .rejects.toThrow(/permission denied/);
    // Grants do not bind the owner. The trigger does.
    await expect(owner.query(`UPDATE shield_evidence_record SET result = 'failed' WHERE id = $1`, [rec.id]))
      .rejects.toThrow(/shield_evidence_append_only/);
    await expect(owner.query(`DELETE FROM shield_evidence_record WHERE id = $1`, [rec.id]))
      .rejects.toThrow(/shield_evidence_append_only/);

    const [row] = await owner.query(`SELECT result FROM shield_evidence_record WHERE id = $1`, [rec.id]);
    expect(row.result).toBe('passed');
  });

  it('a profile with evidence cannot be deleted out from under it', async () => {
    await seedMachine('acme', 'DG-1');
    await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    await expect(owner.query(`DELETE FROM equipment_profile WHERE external_id = 'DG-1'`))
      .rejects.toThrow(/fk_shield_evidence_equipment/);
  });

  // ============================================================= the rules
  it('nobody-owns-it, a blank owner, a bad category or result, and a due date before the check are refused by the database', async () => {
    await seedMachine('acme', 'DG-1');
    const insert = (over: Record<string, unknown>) => {
      const row = {
        category: 'safety', title: 'Check', result: 'passed', performed_at: daysFrom(-1), due_at: null,
        owner_user_id: null, owner_name: 'Someone', ...over,
      };
      return asApp('acme', (q) => q(
        `INSERT INTO shield_evidence_record (tenant_id, source_system, external_id, category, title, result, performed_at, due_at, owner_user_id, owner_name, recorded_by)
           VALUES ('acme', $1, 'DG-1', $2, $3, $4, $5, $6, $7, $8, 'u')`,
        [SS, row.category, row.title, row.result, row.performed_at, row.due_at, row.owner_user_id, row.owner_name],
      ));
    };
    await expect(insert({ owner_name: null })).rejects.toThrow(/ck_shield_evidence_owner/);
    await expect(insert({ owner_name: '   ' })).rejects.toThrow(/ck_shield_evidence_owner/);
    await expect(insert({ category: 'regulation' })).rejects.toThrow(/ck_shield_evidence_category/);
    await expect(insert({ result: 'ok' })).rejects.toThrow(/ck_shield_evidence_result/);
    await expect(insert({ title: ' ' })).rejects.toThrow(/ck_shield_evidence_title/);
    await expect(insert({ due_at: daysFrom(-2) })).rejects.toThrow(/ck_shield_evidence_due/);
    await expect(insert({})).resolves.toBeDefined();
  });

  it('an owner from another account is refused by the database; one from this account is accepted', async () => {
    await seedMachine('acme', 'DG-1');
    const ours = await seedUser('acme', 'ours@acme.test');
    const theirs = await seedUser('globex', 'theirs@globex.test');

    await expect(shield.record(acme, SS, 'DG-1', 'safety', passed({ ownerName: null, ownerUserId: theirs }), NOW))
      .rejects.toThrow(/not a user of this account/);
    // The same refusal with the service out of the way.
    await expect(asApp('acme', (q) => q(
      `INSERT INTO shield_evidence_record (tenant_id, source_system, external_id, category, title, result, performed_at, owner_user_id, recorded_by)
         VALUES ('acme', $1, 'DG-1', 'safety', 'Check', 'passed', $2, $3, 'u')`,
      [SS, daysFrom(-1), theirs],
    ))).rejects.toThrow(/fk_shield_evidence_owner/);

    const rec = await shield.record(acme, SS, 'DG-1', 'safety', passed({ ownerName: null, ownerUserId: ours }), NOW);
    expect(rec.ownerUserId).toBe(ours);
  });

  it('a check performed in the future is refused', async () => {
    await seedMachine('acme', 'DG-1');
    await expect(shield.record(acme, SS, 'DG-1', 'safety', passed({ performedAt: daysFrom(1) }), NOW))
      .rejects.toThrow(/in the future/);
  });

  // ============================================================== isolation
  it('another tenant\'s records are invisible through the service and refused by RLS without it', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('globex', 'DG-1');
    const rec = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);

    expect(await shield.records(globex, SS, 'DG-1')).toEqual([]);
    expect((await shield.summary(globex, NOW)).machines[0].categories.safety.status).toBe('not_recorded');
    await expect(shield.revise(globex, rec.id, passed({ result: 'failed' }), NOW)).rejects.toThrow(/No such evidence record/);

    expect(await asApp('globex', (q) => q(`SELECT id FROM shield_evidence_record`))).toEqual([]);
    await expect(asApp('globex', (q) => q(
      `INSERT INTO shield_evidence_record (tenant_id, source_system, external_id, category, title, result, performed_at, owner_name, recorded_by)
         VALUES ('acme', $1, 'DG-1', 'safety', 'Planted', 'failed', $2, 'x', 'u')`,
      [SS, daysFrom(-1)],
    ))).rejects.toThrow(/row-level security/);
  });

  it('a caller scoped to some machines cannot read or write evidence on the others', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    const other = await shield.record(acme, SS, 'DG-2', 'safety', passed(), NOW);
    const operator: RequestScope = { ...acme, equipmentIds: ['DG-1'] };

    expect((await shield.summary(operator, NOW)).machines.map((m) => m.machine.externalId)).toEqual(['DG-1']);
    await expect(shield.records(operator, SS, 'DG-2')).rejects.toThrow(/No such machine/);
    await expect(shield.record(operator, SS, 'DG-2', 'safety', passed(), NOW)).rejects.toThrow(/No such machine/);
    await expect(shield.revise(operator, other.id, passed({ result: 'failed' }), NOW)).rejects.toThrow(/No such machine/);
  });

  // ================================================================ status
  it('each derived status, and not_recorded where nothing was recorded — never current', async () => {
    for (const id of ['DG-1', 'DG-2', 'DG-3', 'DG-4', 'DG-5']) await seedMachine('acme', id);
    await shield.record(acme, SS, 'DG-1', 'safety', passed({ dueAt: daysFrom(90) }), NOW);
    await shield.record(acme, SS, 'DG-2', 'safety', passed({ dueAt: daysFrom(10) }), NOW);
    await shield.record(acme, SS, 'DG-3', 'safety', passed({ performedAt: daysFrom(-100), dueAt: daysFrom(-1) }), NOW);
    // Failed and long overdue: the failure is what to act on.
    await shield.record(acme, SS, 'DG-4', 'safety', passed({ result: 'failed', performedAt: daysFrom(-100), dueAt: daysFrom(-1) }), NOW);
    await shield.record(acme, SS, 'DG-5', 'safety', passed({ result: 'attention', dueAt: null }), NOW);
    // A one-off that passed has nothing to fall due.
    await shield.record(acme, SS, 'DG-5', 'security', passed({ dueAt: null }), NOW);

    const summary = await shield.summary(acme, NOW);
    const statusOf = (id: string) => summary.machines.find((m) => m.machine.externalId === id)!.categories;
    expect(['DG-1', 'DG-2', 'DG-3', 'DG-4', 'DG-5'].map((id) => statusOf(id).safety.status))
      .toEqual(['current', 'due_soon', 'overdue', 'action_required', 'action_required']);
    expect(statusOf('DG-5').security.status).toBe('current');
    expect(statusOf('DG-1').compliance).toEqual({ status: 'not_recorded', record: null });
    expect(summary.counts).toEqual({ action_required: 2, overdue: 1, due_soon: 1, current: 2, not_recorded: 9 });
  });

  it('the due-soon window is inclusive at its edge and 30 days by default, and says so', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    await shield.record(acme, SS, 'DG-1', 'safety', passed({ dueAt: daysFrom(30) }), NOW);
    await shield.record(acme, SS, 'DG-2', 'safety', passed({ dueAt: new Date(daysFrom(30).getTime() + 1) }), NOW);

    const summary = await shield.summary(acme, NOW);
    expect(summary.machines.map((m) => m.categories.safety.status)).toEqual(['due_soon', 'current']);
    expect(summary.machines[0].dueSoonWindow).toEqual({ days: 30, source: 'default', parameter: null });
  });

  it('shield_due_soon_days set at equipment scope changes that machine only', async () => {
    const dg1 = await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    for (const id of ['DG-1', 'DG-2']) await shield.record(acme, SS, id, 'safety', passed({ dueAt: daysFrom(45) }), NOW);

    const superAdmin: RequestScope = { ...acme, roles: ['super admin'] };
    await app.get(ParameterService).set(superAdmin, {
      scope: 'equipment', scopeRef: dg1, name: 'shield_due_soon_days', value: 60, effectiveFrom: daysFrom(-1),
    });

    const [m1, m2] = (await shield.summary(acme, NOW)).machines;
    expect([m1.categories.safety.status, m1.dueSoonWindow.days, m1.dueSoonWindow.source]).toEqual(['due_soon', 60, 'parameter']);
    expect([m2.categories.safety.status, m2.dueSoonWindow.days, m2.dueSoonWindow.source]).toEqual(['current', 30, 'default']);
  });

  it('a due-soon window that is not a whole number of days, or not positive, is refused by the database', async () => {
    const insert = (value: number) => owner.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ('acme', 'client', NULL, 'shield_due_soon_days', $1::jsonb, 'd', now(), 'u')`,
      [JSON.stringify(value)],
    );
    await expect(insert(0)).rejects.toThrow(/ck_tenant_parameter_value/);
    await expect(insert(7.5)).rejects.toThrow(/ck_tenant_parameter_value/);
    await expect(insert(14)).resolves.toBeDefined();
  });

  it('the latest check is the standing one; an older check that was simply followed by a newer one is history', async () => {
    await seedMachine('acme', 'DG-1');
    await shield.record(acme, SS, 'DG-1', 'safety', passed({ result: 'failed', performedAt: daysFrom(-40) }), NOW);
    await shield.record(acme, SS, 'DG-1', 'safety', passed({ performedAt: daysFrom(-5) }), NOW);
    expect((await shield.summary(acme, NOW)).machines[0].categories.safety.status).toBe('current');
  });

  // ============================================================== revision
  it('a revision corrects a record: the original stays, marked, and the standing status follows the correction', async () => {
    await seedMachine('acme', 'DG-1');
    const original = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    const fixed = await shield.revise(acme, original.id, passed({ result: 'attention', findings: 'Latch loose' }), NOW);

    expect(fixed.supersedesId).toBe(original.id);
    expect(fixed.category).toBe('safety');
    const records = await shield.records(acme, SS, 'DG-1');
    expect(records.map((r) => [r.id, r.supersededById])).toEqual(expect.arrayContaining([
      [original.id, fixed.id], [fixed.id, null],
    ]));
    expect((await shield.summary(acme, NOW)).machines[0].categories.safety)
      .toEqual({ status: 'action_required', record: expect.objectContaining({ id: fixed.id, findings: 'Latch loose' }) });
  });

  it('a revision cannot move to another category or machine — the database refuses it', async () => {
    await seedMachine('acme', 'DG-1');
    await seedMachine('acme', 'DG-2');
    const original = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    const revise = (externalId: string, category: string) => asApp('acme', (q) => q(
      `INSERT INTO shield_evidence_record (tenant_id, source_system, external_id, category, title, result, performed_at, owner_name, recorded_by, supersedes_id)
         VALUES ('acme', $1, $2, $3, 'Moved', 'passed', $4, 'x', 'u', $5)`,
      [SS, externalId, category, daysFrom(-1), original.id],
    ));
    await expect(revise('DG-1', 'security')).rejects.toThrow(/fk_shield_evidence_supersedes/);
    await expect(revise('DG-2', 'safety')).rejects.toThrow(/fk_shield_evidence_supersedes/);
  });

  it('a record is revised once: a different second correction is a 409 naming the first', async () => {
    await seedMachine('acme', 'DG-1');
    const original = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    const first = await shield.revise(acme, original.id, passed({ result: 'failed' }), NOW);
    await expect(shield.revise({ ...acme, userId: 'u-other' }, original.id, passed({ result: 'attention' }), NOW))
      .rejects.toThrow(new RegExp(`already been revised by record ${first.id}`));
  });

  it('concurrent: the same correction retried at once settles every call, writes once', async () => {
    await seedMachine('acme', 'DG-1');
    const original = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    const body = passed({ result: 'failed', findings: 'Interlock bypassed' });

    // Warm the pool first, then fire five. Cold, the first call takes the one idle
    // connection and commits before the others have opened theirs, so every later call
    // takes the already-revised path and the test passes with the unique index gone.
    await Promise.all(Array.from({ length: 5 }, () => shield.records(acme, SS, 'DG-1')));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => shield.revise(acme, original.id, body, NOW)));
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM shield_evidence_record WHERE supersedes_id = $1`, [original.id]);
    expect(n).toBe(1);
  });

  it('concurrent: two different corrections at once — one wins, the other is told which', async () => {
    await seedMachine('acme', 'DG-1');
    const original = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);

    await Promise.all(Array.from({ length: 2 }, () => shield.records(acme, SS, 'DG-1')));
    const results = await Promise.allSettled([
      shield.revise(acme, original.id, passed({ result: 'failed' }), NOW),
      shield.revise({ ...acme, userId: 'u-other' }, original.id, passed({ result: 'attention' }), NOW),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(new RegExp(`already been revised by record ${won.value.id}`));
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM shield_evidence_record WHERE supersedes_id = $1`, [original.id]);
    expect(n).toBe(1);
  });

  // ==================================================================== HTTP
  const bearer = (roles: string[], sub = '00000000-0000-4000-8000-0000000000f1') => app.get(JwtService).signAsync(
    { sub, client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER },
  );
  const body = {
    category: 'safety', title: 'Guard / isolation inspection', result: 'passed',
    performedAt: daysFrom(-1).toISOString(), dueAt: daysFrom(90).toISOString(), ownerName: 'Maintenance lead',
  };

  it('recordedBy is the caller; a body that names someone else is refused, not quietly overridden', async () => {
    await seedMachine('acme', 'DG-1');
    const token = await bearer(['admin']);
    const url = `/api/v1/shield/equipment/${SS}/DG-1/records`;

    const forged = await request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`)
      .send({ ...body, recordedBy: 'someone-else' });
    expect(forged.status).toBe(400);

    const ok = await request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.recordedBy).toBe('00000000-0000-4000-8000-0000000000f1');
  });

  it('a reader can read and is refused on both writes; a role without shield.read sees nothing', async () => {
    await seedMachine('acme', 'DG-1');
    const rec = await shield.record(acme, SS, 'DG-1', 'safety', passed(), NOW);
    const reader = await bearer(['support']);
    const server = app.getHttpServer();

    const summary = await request(server).get('/api/v1/shield/summary').set('Authorization', `Bearer ${reader}`);
    expect(summary.status).toBe(200);
    expect(summary.body.machines[0].categories.safety.record.id).toBe(rec.id);
    expect((await request(server).get(`/api/v1/shield/equipment/${SS}/DG-1/records`).set('Authorization', `Bearer ${reader}`)).status).toBe(200);

    expect((await request(server).post(`/api/v1/shield/equipment/${SS}/DG-1/records`).set('Authorization', `Bearer ${reader}`).send(body)).status).toBe(403);
    const { category: _c, ...revision } = body;
    expect((await request(server).post(`/api/v1/shield/records/${rec.id}/revisions`).set('Authorization', `Bearer ${reader}`).send(revision)).status).toBe(403);

    const platform = await bearer(['platform-support']);
    expect((await request(server).get('/api/v1/shield/summary').set('Authorization', `Bearer ${platform}`)).status).toBe(403);
  });

  // ============================================================ migration
  it('the down path removes the table and the parameter arm; up again grants the shield capabilities to unedited roles only', async () => {
    await undoMigrationNamed(owner, 'ShieldEvidence1759400000000');
    const [{ exists }] = await owner.query(`SELECT to_regclass('shield_evidence_record') IS NOT NULL AS exists`);
    expect(exists).toBe(false);

    const operatorBefore = [
      'action.work', 'catalog.read', 'client-catalog.read',
      'prediction.read', 'utilization.read', 'device.read',
      'equipment-template.read', 'device-catalog.read',
    ];
    await owner.query(`DELETE FROM tenant_role WHERE tenant_id = 'acme'`);
    // Same set as the template, in another order: unedited.
    await owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape, template_slug)
         VALUES ('acme', 'operator', 'Operator', $1::text[], 'equipment', 'operator'),
                ('acme', 'edited-operator', 'Edited', $2::text[], 'equipment', 'operator')`,
      [[...operatorBefore].reverse(), operatorBefore.filter((c) => c !== 'device.read')],
    );

    await owner.runMigrations({ transaction: 'all' });
    const roles: { slug: string; capabilities: string[] }[] = await owner.query(
      `SELECT slug, capabilities FROM tenant_role WHERE tenant_id = 'acme' ORDER BY slug`,
    );
    expect(roles.find((r) => r.slug === 'operator')!.capabilities).toContain('shield.read');
    expect(roles.find((r) => r.slug === 'operator')!.capabilities).not.toContain('shield.write');
    expect(roles.find((r) => r.slug === 'edited-operator')!.capabilities).not.toContain('shield.read');
    await owner.query(`DELETE FROM tenant_role WHERE tenant_id = 'acme'`);
  });
});
