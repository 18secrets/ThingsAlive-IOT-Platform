import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { GeofenceService } from '../src/geofence/geofence.service';
import { distanceToPathM, haversineM, insideZone, LngLat, violates, ZoneShape } from '../src/geofence/geometry';
import { createApp } from '../src/main';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'GeofenceZones1762800000000';
const SECRET = 'test-secret-geofence';
const ISSUER = 'things-alive-geofence-test';

// Near Vizag. 0.001° of latitude is about 111 m everywhere.
const YARD: ZoneShape = { type: 'Polygon', coordinates: [[[83.2, 17.7], [83.21, 17.7], [83.21, 17.71], [83.2, 17.71], [83.2, 17.7]]] };
const PIT: ZoneShape = { type: 'Circle', center: [83.205, 17.705], radiusM: 200 };
const HAUL_ROAD: ZoneShape = { type: 'Corridor', path: [[83.21, 17.705], [83.25, 17.705]], widthM: 100 };
const north = ([lng, lat]: LngLat, metres: number): LngLat => [lng, lat + metres / 111_195];

/** Geofence zones (task QGEO2, stage 1). */
describe('QGEO2: zone geometry', () => {
  it('measures a degree of latitude as about 111 km', () => {
    expect(haversineM([83, 17], [83, 18])).toBeGreaterThan(111_000);
    expect(haversineM([83, 17], [83, 18])).toBeLessThan(111_400);
  });

  it('a circle holds what is within its radius, its edge included, and nothing beyond', () => {
    const c = PIT as Extract<ZoneShape, { type: 'Circle' }>;
    expect(insideZone(PIT, c.center)).toBe(true);
    expect(insideZone(PIT, north(c.center, 199))).toBe(true);
    expect(insideZone(PIT, north(c.center, 201))).toBe(false);
  });

  it('a corridor holds what is within half its width of the path, and measures past an end to the end', () => {
    const mid: LngLat = [83.23, 17.705];
    expect(distanceToPathM([[83.21, 17.705], [83.25, 17.705]], north(mid, 40))).toBeCloseTo(40, 0);
    expect(insideZone(HAUL_ROAD, north(mid, 49))).toBe(true);
    expect(insideZone(HAUL_ROAD, north(mid, 51))).toBe(false);
    // 30 m beyond the east end, on the line: 30 m from the path, so inside a 100 m corridor.
    expect(insideZone(HAUL_ROAD, [83.25 + 30 / (111_195 * Math.cos((17.705 * Math.PI) / 180)), 17.705])).toBe(true);
  });

  it('a polygon zone is QGEO1\'s inside, edge included', () => {
    expect(insideZone(YARD, [83.205, 17.705])).toBe(true);
    expect(insideZone(YARD, [83.2, 17.705])).toBe(true);
    expect(insideZone(YARD, [83.22, 17.705])).toBe(false);
  });

  it('an allowed area or corridor is broken by leaving it; a restricted one by entering', () => {
    expect([violates('allowed', true), violates('allowed', false)]).toEqual([false, true]);
    expect([violates('corridor', true), violates('corridor', false)]).toEqual([false, true]);
    expect([violates('restricted', true), violates('restricted', false)]).toEqual([true, false]);
  });
});

describeDb('QGEO2: geofence zones', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let zones: GeofenceService;
  let plantId: string;
  let otherPlantId: string;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };

  const zone = (over: Record<string, unknown> = {}) => ({
    code: 'PIT', name: 'Blast pit', kind: 'restricted' as const, shape: PIT, appliesTo: 'account' as const, ...over,
  });
  /** Inserted as the application role, so RLS and every constraint apply. */
  const insert = (tenant: string, cols: Record<string, unknown>) => withTenantId(ds, tenant, (m) => m.query(
    `INSERT INTO geofence_zone (tenant_id, code, name, kind, shape, applies_to, plant_id, source_system, external_id,
                                equipment_class_slug, created_by)
       VALUES ($1, $2, 'z', $3, $4::jsonb, $5, $6, $7, $8, $9, 'u')`,
    [tenant, cols.code ?? 'Z', cols.kind ?? 'allowed', JSON.stringify(cols.shape ?? PIT), cols.appliesTo ?? 'account',
      cols.plantId ?? null, cols.sourceSystem ?? null, cols.externalId ?? null, cols.classSlug ?? null],
  ));

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
    ds = app.get(DataSource);
    zones = app.get(GeofenceService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "geofence_zone", "equipment_profile", "client_equipment_class", "plant" CASCADE`);
    [{ id: plantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status, boundary) VALUES ('acme', 'VIZAG', 'Vizag yard', 'active', $1::jsonb) RETURNING id`,
      [JSON.stringify(YARD)],
    );
    [{ id: otherPlantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme', 'PUNE', 'Pune yard', 'active') RETURNING id`,
    );
    await owner.query(`INSERT INTO client_equipment_class (tenant_id, slug, name) VALUES ('acme', 'dumper', 'Dumper')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id, equipment_class_slug)
         VALUES ('acme', 'ta-2.0', 'DT-1', 'Dumper 1', 'client', 'active', 'basic', '{}'::jsonb, $1, 'dumper'),
                ('acme', 'ta-2.0', 'DT-2', 'Dumper 2', 'client', 'active', 'basic', '{}'::jsonb, $2, 'dumper'),
                ('globex', 'ta-2.0', 'G-1', 'Globex rig', 'client', 'active', 'basic', '{}'::jsonb, NULL, NULL)`,
      [plantId, otherPlantId],
    );
  });

  describe('the database refuses a zone that would be misread', () => {
    it('a malformed shape of each type', async () => {
      const bad: unknown[] = [
        { type: 'Circle', center: [83.2, 17.7], radiusM: 0 },
        { type: 'Circle', center: [83.2, 17.7], radiusM: 50_001 },
        { type: 'Circle', center: [17.7, 183.2], radiusM: 100 },
        { type: 'Circle', center: [83.2, 17.7], radiusM: '200' },
        { type: 'Corridor', path: [[83.2, 17.7]], widthM: 50 },
        { type: 'Polygon', coordinates: [[[83.2, 17.7], [83.21, 17.7], [83.21, 17.71], [83.2, 17.71]]] },
        { type: 'Square', side: 10 },
      ];
      for (const shape of bad) {
        const kind = (shape as { type: string }).type === 'Corridor' ? 'corridor' : 'allowed';
        await expect(insert('acme', { shape, kind })).rejects.toThrow(/ck_geofence_zone_shape/);
      }
    });

    it('a corridor kind without a corridor shape, and a corridor shape on an area kind', async () => {
      await expect(insert('acme', { kind: 'corridor', shape: PIT })).rejects.toThrow(/ck_geofence_zone_corridor/);
      await expect(insert('acme', { kind: 'restricted', shape: HAUL_ROAD })).rejects.toThrow(/ck_geofence_zone_corridor/);
    });

    it('a target that does not match what the zone says it applies to', async () => {
      await expect(insert('acme', { appliesTo: 'plant' })).rejects.toThrow(/ck_geofence_zone_scope/);
      await expect(insert('acme', { appliesTo: 'account', plantId })).rejects.toThrow(/ck_geofence_zone_scope/);
    });

    it('a target in another account, even by its exact id', async () => {
      await expect(insert('globex', { appliesTo: 'plant', plantId })).rejects.toThrow(/fk_geofence_zone_plant/);
      await expect(insert('globex', { appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'DT-1' }))
        .rejects.toThrow(/fk_geofence_zone_equipment/);
    });

    it('a second zone with the same code in one account, while another account may use it', async () => {
      await insert('acme', { code: 'PIT' });
      await expect(insert('acme', { code: 'PIT' })).rejects.toThrow(/uq_geofence_zone_code/);
      await expect(insert('globex', { code: 'PIT' })).resolves.toBeDefined();
    });

    it('moving a zone to another target or code, whatever path the update takes', async () => {
      await insert('acme', { code: 'MINE', appliesTo: 'plant', plantId });
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `UPDATE geofence_zone SET plant_id = $1 WHERE code = 'MINE'`, [otherPlantId],
      ))).rejects.toThrow(/cannot change/);
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `UPDATE geofence_zone SET code = 'OTHER' WHERE code = 'MINE'`,
      ))).rejects.toThrow(/cannot change/);
    });

    it('another account cannot see or change a zone', async () => {
      await insert('acme', { code: 'MINE' });
      expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT * FROM geofence_zone`))).toEqual([]);
      const [, changed] = await withTenantId(ds, 'globex', (m) => m.query(`UPDATE geofence_zone SET name = 'x'`));
      expect(changed).toBe(0);
    });
  });

  describe('authoring', () => {
    it('creates each kind, with each target, and lists them by code', async () => {
      await zones.create(acme, zone());
      await zones.create(acme, zone({ code: 'YARD', kind: 'allowed', shape: YARD, appliesTo: 'plant', plantId }));
      await zones.create(acme, zone({ code: 'ROAD', kind: 'corridor', shape: HAUL_ROAD, appliesTo: 'equipment-class', equipmentClassSlug: 'dumper' }));
      await zones.create(acme, zone({ code: 'DT1', kind: 'allowed', shape: YARD, appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'DT-1' }));
      expect((await zones.list(acme)).map((z) => [z.code, z.kind, z.appliesTo])).toEqual([
        ['DT1', 'allowed', 'equipment'], ['PIT', 'restricted', 'account'],
        ['ROAD', 'corridor', 'equipment-class'], ['YARD', 'allowed', 'plant'],
      ]);
    });

    it('says what is wrong with a shape, a target or a duplicate, in words', async () => {
      await expect(zones.create(acme, zone({ shape: { type: 'Circle', center: [83.2, 17.7], radiusM: -1 } })))
        .rejects.toThrow(/Shape refused: a Circle's "radiusM" is metres/);
      await expect(zones.create(acme, zone({ appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'G-1' })))
        .rejects.toThrow(/No such machine/);
      await expect(zones.create(acme, zone({ appliesTo: 'equipment-class', equipmentClassSlug: 'crane' })))
        .rejects.toThrow(/No such machine type/);
      await zones.create(acme, zone());
      await expect(zones.create(acme, zone())).rejects.toMatchObject({ status: 409 });
    });

    it('updates name, shape, kind and switch, and refuses a kind that does not fit the shape', async () => {
      const z = await zones.create(acme, zone());
      const changed = await zones.update(acme, z.id, { name: 'Pit 2', shape: YARD, kind: 'allowed', enabled: false });
      expect(changed).toMatchObject({ name: 'Pit 2', kind: 'allowed', enabled: false, code: 'PIT' });
      await expect(zones.update(acme, z.id, { kind: 'corridor' })).rejects.toThrow(/corridor zone has a Corridor shape/);
    });

    it('a zone goes when the machine, site or type it applies to is deleted', async () => {
      await zones.create(acme, zone({ code: 'DT1', kind: 'allowed', shape: YARD, appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'DT-1' }));
      await owner.query(`DELETE FROM equipment_profile WHERE external_id = 'DT-1'`);
      expect(await zones.list(acme)).toEqual([]);
    });

    it('a person narrowed to one site neither sees nor targets a zone on another', async () => {
      await zones.create(acme, zone({ code: 'PUNE', kind: 'allowed', shape: YARD, appliesTo: 'plant', plantId: otherPlantId }));
      await zones.create(acme, zone());
      const vizagOnly: RequestScope = { ...acme, plantIds: [plantId], equipmentIds: ['DT-1'] };
      expect((await zones.list(vizagOnly)).map((z) => z.code)).toEqual(['PIT']);
      await expect(zones.create(vizagOnly, zone({ code: 'X', appliesTo: 'plant', plantId: otherPlantId })))
        .rejects.toThrow(/No such site/);
      await expect(zones.create(vizagOnly, zone({ code: 'Y', appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'DT-2' })))
        .rejects.toThrow(/No such machine/);
    });
  });

  describe('which zones apply to a machine, and where a position stands', () => {
    beforeEach(async () => {
      await zones.create(acme, zone());
      await zones.create(acme, zone({ code: 'ROAD', kind: 'corridor', shape: HAUL_ROAD, appliesTo: 'equipment-class', equipmentClassSlug: 'dumper' }));
      await zones.create(acme, zone({ code: 'PUNE', kind: 'allowed', shape: YARD, appliesTo: 'plant', plantId: otherPlantId }));
      await zones.create(acme, zone({ code: 'DT2', kind: 'allowed', shape: YARD, appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'DT-2' }));
      const off = await zones.create(acme, zone({ code: 'OFF' }));
      await zones.update(acme, off.id, { enabled: false });
    });

    it('its account, site, type and own zones, and its site boundary as an allowed zone; nothing switched off', async () => {
      expect((await zones.zonesFor(acme, 'ta-2.0', 'DT-1')).map((z) => [z.code, z.source, z.kind])).toEqual([
        ['site:VIZAG', 'site-boundary', 'allowed'], ['PIT', 'zone', 'restricted'], ['ROAD', 'zone', 'corridor'],
      ]);
      expect((await zones.zonesFor(acme, 'ta-2.0', 'DT-2')).map((z) => z.code)).toEqual(['DT2', 'PIT', 'PUNE', 'ROAD']);
    });

    it('in the pit: inside the yard, inside the restricted pit — a violation — and off the haul road', async () => {
      const result = await zones.check(acme, 'ta-2.0', 'DT-1', [83.205, 17.705]);
      expect(result.map((z) => [z.code, z.inside, z.violation])).toEqual([
        ['site:VIZAG', true, false], ['PIT', true, true], ['ROAD', false, true],
      ]);
    });

    it('on the haul road, outside the yard: the yard is broken, the road and pit are not', async () => {
      const result = await zones.check(acme, 'ta-2.0', 'DT-1', [83.23, 17.7052]);
      expect(result.map((z) => [z.code, z.inside, z.violation])).toEqual([
        ['site:VIZAG', false, true], ['PIT', false, false], ['ROAD', true, false],
      ]);
    });

    it('a machine whose site the caller cannot see gets its own zones, but not the site\'s fence or name', async () => {
      const machineOnly: RequestScope = { ...acme, plantIds: [], equipmentIds: ['DT-1'] };
      const codes = (await zones.zonesFor(machineOnly, 'ta-2.0', 'DT-1')).map((z) => z.code);
      expect(codes).toEqual(['PIT', 'ROAD']);
    });

    it('refuses a machine in another account, and a position off the globe', async () => {
      await expect(zones.zonesFor(globex, 'ta-2.0', 'DT-1')).rejects.toThrow(/No such machine/);
      await expect(zones.check(acme, 'ta-2.0', 'DT-1', [17.7, 183.2])).rejects.toThrow(/latitude within/);
    });
  });

  describe('over HTTP', () => {
    const token = (roles: string[]) => app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000b1', client_id: 'acme', roles }, { secret: SECRET, issuer: ISSUER },
    );

    it('an admin adds a zone; an operator may read and check, but not add', async () => {
      const admin = `Bearer ${await token(['admin'])}`;
      const operator = `Bearer ${await token(['operational'])}`;
      const created = await request(app.getHttpServer()).post('/api/v1/geofences').set('Authorization', admin).send(zone());
      expect(created.status).toBe(201);

      expect((await request(app.getHttpServer()).post('/api/v1/geofences').set('Authorization', operator)
        .send(zone({ code: 'OTHER' }))).status).toBe(403);
      const listed = await request(app.getHttpServer()).get('/api/v1/geofences').set('Authorization', operator);
      expect(listed.body.map((z: { code: string }) => z.code)).toEqual(['PIT']);
      const checked = await request(app.getHttpServer()).post('/api/v1/equipment/ta-2.0/DT-1/geofences/check')
        .set('Authorization', operator).send({ lng: 83.205, lat: 17.705 });
      expect(checked.status).toBe(200);
      expect(checked.body.find((z: { code: string }) => z.code === 'PIT')).toMatchObject({ inside: true, violation: true });
    });

    it('refuses an unknown kind or target before the service, and an anonymous caller', async () => {
      const admin = `Bearer ${await token(['admin'])}`;
      expect((await request(app.getHttpServer()).post('/api/v1/geofences').set('Authorization', admin)
        .send(zone({ kind: 'forbidden' }))).status).toBe(400);
      expect((await request(app.getHttpServer()).post('/api/v1/geofences').set('Authorization', admin)
        .send(zone({ appliesTo: 'world' }))).status).toBe(400);
      expect((await request(app.getHttpServer()).get('/api/v1/geofences')).status).toBe(401);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it(`${MIGRATION} down drops the table, its functions and the plant index, and up brings them back`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('geofence_zone') AS t, to_regclass('uq_plant_tenant_id') AS i`))
      .toEqual([{ t: null, i: null }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'geofence_%'`)).toEqual([{ n: 0 }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('geofence_zone')::text AS t`)).toEqual([{ t: 'geofence_zone' }]);
  });
});
