import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { createApp } from '../src/main';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SECRET = 'test-secret-client-templates';
const ISSUER = 'things-alive-client-templates-test';
const MIGRATION = 'ClientEquipmentTemplates1761900000000';

const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
const master: RequestScope = { tenantId: '', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };

/**
 * A client's own equipment templates (task QCLIENT-TEMPLATE). The refusals are attempted:
 * another account reads, edits, deletes; the database is handed a negative tank and a
 * blank name — and each is expected to say no.
 */
describeDb('client equipment templates', () => {
  let owner: DataSource;
  let appDs: DataSource;
  let app: INestApplication;
  let templates: ClientEquipmentTemplateService;

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
    templates = app.get(ClientEquipmentTemplateService);
    appDs = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await app?.close(); await appDs?.destroy(); await owner?.destroy(); });
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "client_equipment_template", "equipment_template" RESTART IDENTITY CASCADE`);
  });

  const seedMaster = async () => {
    const [row] = await owner.query(
      `INSERT INTO equipment_template (name, category, manufacturer, engine_type, fuel_tank_capacity_liters, service_interval_hours, description)
         VALUES ('CAT 320', 'Excavator', 'Caterpillar', 'C7.1', 410, 250, 'Master default') RETURNING id`,
    );
    return row.id as string;
  };

  /** A tenant session as the running service holds one: `ta_app`, tenant set, no bypass. */
  const asApp = <R>(tenant: string, fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<R>) =>
    appDs.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn((sql, params) => m.query(sql, params));
    });

  // ============================================================== isolation
  it('another account cannot list, read, edit or delete a template — and RLS refuses it without the service', async () => {
    const mine = await templates.create(acme, { name: 'Generator 250 kVA', fuelTankCapacityLiters: 600 });

    expect(await templates.list(globex)).toEqual([]);
    await expect(templates.update(globex, mine.id, { name: 'Taken' })).rejects.toThrow(/No equipment template/);
    await expect(templates.remove(globex, mine.id)).rejects.toThrow(/No equipment template/);
    expect((await templates.list(acme)).map((t) => t.name)).toEqual(['Generator 250 kVA']);

    expect(await asApp('globex', (q) => q(`SELECT id FROM client_equipment_template`))).toEqual([]);
    expect(await asApp('globex', (q) => q(`UPDATE client_equipment_template SET name = 'x' WHERE id = $1 RETURNING id`, [mine.id]))).toEqual([[], 0]);
    await expect(asApp('globex', (q) => q(
      `INSERT INTO client_equipment_template (tenant_id, name, created_by, updated_by) VALUES ('acme', 'Planted', 'u', 'u')`,
    ))).rejects.toThrow(/row-level security/);
  });

  // ============================================================== the rules
  it('a blank name, a non-positive tank, a zero or fractional interval are refused by the database', async () => {
    const insert = (cols: Record<string, unknown>) => asApp('acme', (q) => q(
      `INSERT INTO client_equipment_template (tenant_id, name, fuel_tank_capacity_liters, service_interval_hours, created_by, updated_by)
         VALUES ('acme', $1, $2, $3, 'u', 'u')`,
      [cols.name ?? 'Ok', cols.tank ?? null, cols.interval ?? null],
    ));
    await expect(insert({ name: '  ' })).rejects.toThrow(/ck_client_equipment_template_name/);
    await expect(insert({ tank: 0 })).rejects.toThrow(/ck_client_equipment_template_tank/);
    await expect(insert({ tank: -5 })).rejects.toThrow(/ck_client_equipment_template_tank/);
    await expect(insert({ interval: 0 })).rejects.toThrow(/ck_client_equipment_template_interval/);
    await expect(insert({ interval: '2.5' })).rejects.toThrow(/integer/);
    await expect(insert({ tank: 410.5, interval: 250 })).resolves.toBeDefined();
  });

  it('names are unique per account, ignoring case — and only per account', async () => {
    await templates.create(acme, { name: 'CAT 320' });
    await expect(templates.create(acme, { name: 'cat 320' })).rejects.toThrow(/already has a template with that name/);
    await expect(templates.create(globex, { name: 'CAT 320' })).resolves.toBeDefined();
  });

  // ================================================================ copying
  it('copy from master: fields and provenance copied; later edits on either side stay on that side', async () => {
    const masterId = await seedMaster();
    const copy = await templates.copyFromMaster(acme, masterId);
    expect(copy).toEqual(expect.objectContaining({
      name: 'CAT 320', category: 'Excavator', manufacturer: 'Caterpillar', engineType: 'C7.1',
      fuelTankCapacityLiters: 410, serviceIntervalHours: 250, description: 'Master default', copiedFromId: masterId,
    }));

    await owner.query(`UPDATE equipment_template SET service_interval_hours = 500 WHERE id = $1`, [masterId]);
    expect((await templates.list(acme))[0].serviceIntervalHours).toBe(250);

    await templates.update(acme, copy.id, { fuelTankCapacityLiters: 380 });
    const [m] = await owner.query(`SELECT fuel_tank_capacity_liters AS tank FROM equipment_template WHERE id = $1`, [masterId]);
    expect(m.tank).toBe(410);
  });

  it('a second copy of the same master needs its own name', async () => {
    const masterId = await seedMaster();
    await templates.copyFromMaster(acme, masterId);
    await expect(templates.copyFromMaster(acme, masterId)).rejects.toThrow(/already has a template with that name/);
    expect((await templates.copyFromMaster(acme, masterId, 'CAT 320 — long stick')).copiedFromId).toBe(masterId);
  });

  it('PATCH with one field leaves the rest as they were', async () => {
    const t = await templates.create(acme, {
      name: 'Genset', category: 'Power', manufacturer: 'Kirloskar', fuelTankCapacityLiters: 600, serviceIntervalHours: 500,
    });
    // As the controller hands it over: a DTO with every other field present as undefined.
    const patched = await templates.update(acme, t.id, {
      name: undefined, category: undefined, manufacturer: undefined, engineType: undefined,
      fuelTankCapacityLiters: undefined, serviceIntervalHours: 250, description: undefined,
    });
    expect(patched).toEqual(expect.objectContaining({
      name: 'Genset', category: 'Power', manufacturer: 'Kirloskar', fuelTankCapacityLiters: 600, serviceIntervalHours: 250,
      updatedBy: 'u-acme',
    }));
  });

  it('delete removes it; deleting again is a 404', async () => {
    const t = await templates.create(acme, { name: 'Short-lived' });
    await templates.remove(acme, t.id);
    expect(await templates.list(acme)).toEqual([]);
    await expect(templates.remove(acme, t.id)).rejects.toThrow(/No equipment template/);
  });

  // ==================================================================== HTTP
  const bearer = (roles: string[], tenant = 'acme') => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000c1', client_id: tenant, roles }, { secret: SECRET, issuer: ISSUER },
  );

  it('a platform role is refused on every route, though it holds both capabilities', async () => {
    const t = await templates.create(acme, { name: 'Ours' });
    await expect(templates.list(master)).rejects.toThrow(/no platform access path/);
    await expect(templates.create(master, { name: 'Theirs' })).rejects.toThrow(/no platform access path/);
    await expect(templates.update(master, t.id, { name: 'x' })).rejects.toThrow(/no platform access path/);
    await expect(templates.remove(master, t.id)).rejects.toThrow(/no platform access path/);

    // A platform token still names a tenant; what it lacks is any ordinary route into it.
    const token = await bearer(['master-admin'], 'acme');
    expect((await request(app.getHttpServer()).get('/api/v1/my-equipment-templates').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('over HTTP: an admin creates; a reader lists but cannot write; Master Admin\'s library stays closed to clients', async () => {
    const server = app.getHttpServer();
    const admin = await bearer(['admin']);
    const created = await request(server).post('/api/v1/my-equipment-templates').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Tractor 75 HP', category: 'Tractor', serviceIntervalHours: 300 });
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ name: 'Tractor 75 HP', createdBy: '00000000-0000-4000-8000-0000000000c1' }));

    const fractional = await request(server).post('/api/v1/my-equipment-templates').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Bad', serviceIntervalHours: 2.5 });
    expect(fractional.status).toBe(400);

    // A client user's capabilities come from their account's role row, not the static
    // table — so the reader is a real user on a role holding only the read.
    await owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES ('acme', 'template-reader', 'Reader', '{equipment-template.read}', 'tenant')`,
    );
    const [user] = await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', 'reader@acme.test', 'Reader', 'template-reader', 'active') RETURNING id`,
    );
    const reader = await app.get(JwtService).signAsync(
      { sub: user.id, client_id: 'acme', roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
    );
    try {
      const listed = await request(server).get('/api/v1/my-equipment-templates').set('Authorization', `Bearer ${reader}`);
      expect(listed.status).toBe(200);
      expect(listed.body.map((t: { name: string }) => t.name)).toEqual(['Tractor 75 HP']);
      expect((await request(server).post('/api/v1/my-equipment-templates').set('Authorization', `Bearer ${reader}`).send({ name: 'Nope' })).status).toBe(403);
    } finally {
      await owner.query(`DELETE FROM app_user WHERE tenant_id = 'acme'`);
      await owner.query(`DELETE FROM tenant_role WHERE tenant_id = 'acme'`);
    }

    expect((await request(server).post('/api/v1/equipment-templates').set('Authorization', `Bearer ${admin}`).send({ name: 'Into the shared table' })).status).toBe(403);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM equipment_template`);
    expect(n).toBe(0);

    const del = await request(server).delete(`/api/v1/my-equipment-templates/${created.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(204);
  });

  // ============================================================== migration
  it('the down path drops the table and leaves Master Admin\'s alone', async () => {
    await seedMaster();
    await undoMigrationNamed(owner, MIGRATION);
    const [{ client, shared }] = await owner.query(
      `SELECT to_regclass('client_equipment_template') IS NOT NULL AS client, to_regclass('equipment_template') IS NOT NULL AS shared`,
    );
    expect({ client, shared }).toEqual({ client: false, shared: true });
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM equipment_template`);
    expect(n).toBe(1);
    await owner.runMigrations({ transaction: 'all' });
  });
});
