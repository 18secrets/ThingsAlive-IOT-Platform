import { INestApplication, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { EquipmentTemplateService } from '../src/equipment-template/services/equipment-template.service';
import { createApp } from '../src/main';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SECRET = 'test-secret-model-grants';
const ISSUER = 'things-alive-model-grants-test';
const MIGRATION = 'ModelGrants1766000000000';

const master: RequestScope = { tenantId: '', userId: 'deepak', roles: ['master-admin'], isPlatformRole: true };
const motors: RequestScope = { tenantId: 'motors', userId: 'u-motors', roles: ['admin'], isPlatformRole: false };
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

jest.setTimeout(60_000);

/**
 * Library models are given to accounts, as classes are (TC_234). The testing sheet's
 * case: an account's "Copy a library model" list showed every model in the library,
 * other accounts' included. Every refusal here is attempted — an account copying a model
 * it was not given, by the service and by raw SQL in its own session; an account writing
 * itself a grant; an account reading a model's ratings by id — and expected to be refused.
 */
describeDb('library models given to accounts (TC_234)', () => {
  let owner: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let library: EquipmentTemplateService;
  let copies: ClientEquipmentTemplateService;

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
    library = app.get(EquipmentTemplateService);
    copies = app.get(ClientEquipmentTemplateService);
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await app?.close(); await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "equipment_template_grant", "client_equipment_template", "equipment_template" CASCADE`);
    for (const [id, name] of [['motors', 'Motors'], ['acme', 'Acme']]) {
      await owner.query(`INSERT INTO "tenant" ("tenant_id", "name") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, name]);
    }
  });

  /** The two models of the testing sheet's case: a pump for Motors, a generator for nobody yet. */
  const twoModels = async () => {
    const pump = await library.create({ name: 'Crompton Mini 1 HP', manufacturer: 'Crompton', equipmentClassSlug: 'monoblock-pump-1ph' });
    const genset = await library.create({ name: 'MINI', manufacturer: 'Prem', equipmentClassSlug: 'diesel-generator' });
    return { pump, genset };
  };

  const bearer = (roles: string[], tenant: string) => app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000c1', client_id: tenant, roles }, { secret: SECRET, issuer: ISSUER },
  );

  describe('what an account sees', () => {
    it('an account lists only the models it was given; another account\'s grant shows it nothing', async () => {
      const { pump, genset } = await twoModels();
      expect(await library.list(motors)).toEqual([]);
      await library.grant(master, 'motors', pump.id);
      await library.grant(master, 'acme', genset.id);
      expect((await library.list(motors)).map((t) => t.name)).toEqual(['Crompton Mini 1 HP']);
      expect((await library.list(acme)).map((t) => t.name)).toEqual(['MINI']);
    });

    it('Master Admin still sees the whole library, given to anyone or not', async () => {
      await twoModels();
      expect((await library.list(master)).map((t) => t.name)).toEqual(['Crompton Mini 1 HP', 'MINI']);
    });

    it('a model\'s ratings and duty curve are not found for an account not given it', async () => {
      const { pump } = await twoModels();
      await library.replaceRatings(master, pump.id, [{ name: 'rated_current', value: 5.5, source: 'Datasheet p.2' }]);
      await expect(library.ratingsFor(motors, pump.id)).rejects.toThrow(NotFoundException);
      await expect(library.dutyCurveFor(motors, pump.id)).rejects.toThrow(NotFoundException);
      await library.grant(master, 'motors', pump.id);
      expect(await library.ratingsFor(motors, pump.id)).toEqual([expect.objectContaining({ name: 'rated_current', value: 5.5 })]);
    });

    it('over HTTP: the account\'s list is its grants; Master Admin\'s is the library', async () => {
      const { pump } = await twoModels();
      await library.grant(master, 'motors', pump.id);
      const server = app.getHttpServer();
      // A client user's read comes from their account's role row, not the static table,
      // so each reader is a real user on a role holding equipment-template.read.
      const readers: Record<string, string> = {};
      for (const tenant of ['motors', 'acme']) {
        await owner.query(
          `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES ($1, 'model-reader', 'Reader', '{equipment-template.read}', 'tenant')`,
          [tenant],
        );
        const [user] = await owner.query(
          `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ($1, $2, 'Reader', 'model-reader', 'active') RETURNING id`,
          [tenant, `reader@${tenant}.test`],
        );
        readers[tenant] = await app.get(JwtService).signAsync(
          { sub: user.id, client_id: tenant, roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
        );
      }
      try {
        const mine = await request(server).get('/api/v1/equipment-templates').set('Authorization', `Bearer ${readers.motors}`);
        expect(mine.status).toBe(200);
        expect(mine.body.map((t: { name: string }) => t.name)).toEqual(['Crompton Mini 1 HP']);
        const theirs = await request(server).get('/api/v1/equipment-templates').set('Authorization', `Bearer ${readers.acme}`);
        expect(theirs.status).toBe(200);
        expect(theirs.body).toEqual([]);
        const curve = await request(server).get(`/api/v1/equipment-templates/${pump.id}/duty-curve`).set('Authorization', `Bearer ${readers.acme}`);
        expect(curve.status).toBe(404);
      } finally {
        await owner.query(`DELETE FROM app_user WHERE email LIKE 'reader@%.test'`);
        await owner.query(`DELETE FROM tenant_role WHERE slug = 'model-reader'`);
      }
      const all = await request(server).get('/api/v1/equipment-templates').set('Authorization', `Bearer ${await bearer(['master-admin'], 'acme')}`);
      expect(all.body.map((t: { name: string }) => t.name)).toEqual(['Crompton Mini 1 HP', 'MINI']);
    });
  });

  describe('copying', () => {
    it('a model the account was not given is not found, the same answer as one that does not exist', async () => {
      const { pump, genset } = await twoModels();
      await library.grant(master, 'motors', pump.id);
      await expect(copies.copyFromMaster(motors, genset.id)).rejects.toThrow(NotFoundException);
      await expect(copies.copyFromMaster(acme, pump.id)).rejects.toThrow(NotFoundException);
      expect((await copies.copyFromMaster(motors, pump.id)).copiedFromId).toBe(pump.id);
    });

    it('the database refuses an ungranted copy written straight into the account\'s own session', async () => {
      const { pump } = await twoModels();
      const write = () => withTenantId(ds, 'motors', (m) => m.query(
        `INSERT INTO client_equipment_template (tenant_id, name, copied_from_id, created_by, updated_by)
         VALUES ('motors', 'Smuggled', $1, 'u', 'u')`, [pump.id],
      ));
      await expect(write()).rejects.toThrow(/not given to account motors/);
      // Another account's grant of the same model does not let this one through.
      await library.grant(master, 'acme', pump.id);
      await expect(write()).rejects.toThrow(/not given to account motors/);
      await library.grant(master, 'motors', pump.id);
      await expect(write()).resolves.toBeDefined();
    });

    it('nor can a copy be re-pointed at a model the account was not given', async () => {
      const { pump, genset } = await twoModels();
      await library.grant(master, 'motors', pump.id);
      const copy = await copies.copyFromMaster(motors, pump.id);
      await expect(withTenantId(ds, 'motors', (m) => m.query(
        `UPDATE client_equipment_template SET copied_from_id = $1 WHERE id = $2`, [genset.id, copy.id],
      ))).rejects.toThrow(/not given to account motors/);
    });

    it('a template of the account\'s own, copied from nothing, needs no grant', async () => {
      await expect(copies.create(motors, { name: 'Our own pump' })).resolves.toBeDefined();
    });

    it('over HTTP: copying an ungranted model is a 404', async () => {
      const { genset } = await twoModels();
      const res = await request(app.getHttpServer()).post(`/api/v1/my-equipment-templates/from/${genset.id}`)
        .set('Authorization', `Bearer ${await bearer(['admin'], 'motors')}`).send({});
      expect(res.status).toBe(404);
    });
  });

  describe('granting', () => {
    it('an account cannot write itself a grant: the database refuses it in the account\'s own session', async () => {
      const { pump } = await twoModels();
      await expect(withTenantId(ds, 'motors', (m) => m.query(
        `INSERT INTO equipment_template_grant (tenant_id, template_id, granted_by) VALUES ('motors', $1, 'u-motors')`, [pump.id],
      ))).rejects.toThrow(/row-level security/);
    });

    it('nor over HTTP: granting is Master Admin\'s', async () => {
      const { pump } = await twoModels();
      const server = app.getHttpServer();
      const client = await bearer(['admin'], 'motors');
      expect((await request(server).post('/api/v1/equipment-templates/grants').set('Authorization', `Bearer ${client}`)
        .send({ tenantId: 'motors', templateId: pump.id })).status).toBe(403);
      expect((await request(server).get('/api/v1/equipment-templates/grants').set('Authorization', `Bearer ${client}`)).status).toBe(403);
      const admin = await bearer(['master-admin'], 'motors');
      const granted = await request(server).post('/api/v1/equipment-templates/grants').set('Authorization', `Bearer ${admin}`)
        .send({ tenantId: 'motors', templateId: pump.id, note: 'POC' });
      expect(granted.status).toBe(201);
      const listed = await request(server).get('/api/v1/equipment-templates/grants?tenantId=motors').set('Authorization', `Bearer ${admin}`);
      expect(listed.body).toEqual([expect.objectContaining({ tenantId: 'motors', templateId: pump.id, note: 'POC', revokedAt: null })]);
    });

    it('an account reads its own grants and nobody else\'s', async () => {
      const { pump, genset } = await twoModels();
      await library.grant(master, 'motors', pump.id);
      await library.grant(master, 'acme', genset.id);
      const seen = await withTenantId(ds, 'acme', (m) => m.query(`SELECT tenant_id FROM equipment_template_grant`));
      expect(seen).toEqual([{ tenant_id: 'acme' }]);
    });

    it('two grants fired together both settle and leave one grant', async () => {
      const { pump } = await twoModels();
      const results = await Promise.allSettled([
        library.grant(master, 'motors', pump.id), library.grant(master, 'motors', pump.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const ids = results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
      expect(ids[0]).toBe(ids[1]);
      expect(await owner.query(`SELECT 1 FROM equipment_template_grant`)).toHaveLength(1);
    });

    it('revoked, the model leaves the account\'s list but its copy stays; granted again, the same row comes back', async () => {
      const { pump } = await twoModels();
      const first = await library.grant(master, 'motors', pump.id);
      const copy = await copies.copyFromMaster(motors, pump.id);
      const revoked = await library.revoke(master, first.id);
      expect(revoked.revokedBy).toBe('deepak');
      expect(await library.list(motors)).toEqual([]);
      // D04: the copy is the account's, and a machine may read its ratings from it.
      expect((await copies.list(motors)).map((t) => t.id)).toEqual([copy.id]);
      await expect(copies.copyFromMaster(motors, pump.id, 'Second copy')).rejects.toThrow(NotFoundException);
      await expect(library.revoke(master, first.id)).rejects.toThrow(NotFoundException);
      const again = await library.grant(master, 'motors', pump.id);
      expect(again.id).toBe(first.id);
      expect(again.revokedAt).toBeNull();
    });

    it('a model that does not exist, or an account that does not, is refused', async () => {
      const { pump } = await twoModels();
      await expect(library.grant(master, 'motors', '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/No equipment template/);
      await expect(library.grant(master, 'motors', 'not-a-uuid')).rejects.toThrow(/No equipment template/);
      await expect(library.grant(master, 'nobody', pump.id)).rejects.toThrow(/No account "nobody"/);
    });

    it('a model taken out of the library takes its grants with it', async () => {
      const { pump } = await twoModels();
      await library.grant(master, 'motors', pump.id);
      await owner.query(`DELETE FROM equipment_template WHERE id = $1`, [pump.id]);
      expect(await owner.query(`SELECT 1 FROM equipment_template_grant`)).toHaveLength(0);
    });
  });

  it(`${MIGRATION} comes off and goes back on, giving each account the models it already holds a copy of`, async () => {
    const { pump } = await twoModels();
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('equipment_template_grant') AS t`)).toEqual([{ t: null }]);
    // Before: any account could copy any model, and Motors did.
    await owner.query(
      `INSERT INTO client_equipment_template (tenant_id, name, copied_from_id, created_by, updated_by) VALUES ('motors', 'Our pump', $1, 'u', 'u')`,
      [pump.id],
    );
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT tenant_id, template_id, granted_by FROM equipment_template_grant`)).toEqual([
      { tenant_id: 'motors', template_id: pump.id, granted_by: 'migration' },
    ]);
    expect((await library.list(motors)).map((t) => t.id)).toEqual([pump.id]);
    expect(await library.list(acme)).toEqual([]);
  });
});
