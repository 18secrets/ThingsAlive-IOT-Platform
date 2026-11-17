import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { composeAround, composeLayout, Draft } from '../src/site-twin/compose';
import { LayoutInput, SiteTwinService, ZoneInput } from '../src/site-twin/site-twin.service';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-site-twin-arrange';
const ISSUER = 'things-alive-site-twin-arrange-test';
const SRC = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };

const m = (externalId: string, category: string | null, attention = false) =>
  ({ sourceSystem: SRC, externalId, category, classSlug: null, attention });
const EARTH = 'Excavators & Earthmoving';

/** Two zones touch when they come closer than the composer's clearance, as it judges. */
const apart = (a: ZoneInput, b: ZoneInput) =>
  Math.abs(a.x - b.x) >= (a.widthM + b.widthM) / 2 || Math.abs(a.z - b.z) >= (a.depthM + b.depthM) / 2;
const inside = (z: ZoneInput, l: LayoutInput) =>
  Math.abs(z.x) + z.widthM / 2 <= l.extent.widthM / 2 && Math.abs(z.z) + z.depthM / 2 <= l.extent.depthM / 2;
const holds = (z: ZoneInput, x: number, y: number) => Math.abs(x - z.x) <= z.widthM / 2 && Math.abs(y - z.z) <= z.depthM / 2;

/**
 * Auto-arrange around what is drawn (4 Nov): a zone drawn in the editor, then
 * "Auto-arrange from equipment", and the zone was gone — the composer started from
 * nothing and the draft was replaced. These hold it to adding, never taking away: every
 * drawn zone comes back as drawn, a structure already drawn is the one its machines go
 * to, and what is added lands clear of the drawing.
 */
describe('auto-arrange around the draft', () => {
  const laydown: ZoneInput = { key: 'zone-1', label: 'Laydown', kind: 'material_yard', x: 0, z: 0, widthM: 24, depthM: 16 };
  const draft = (zones: ZoneInput[], extent = { widthM: 200, depthM: 120 }): Draft => ({ extent, zones });

  it('keeps a drawn zone exactly as drawn, and adds nothing on top of it', () => {
    const l = composeAround([m('E1', EARTH), m('G1', 'Power Generation')], draft([laydown]), 7);
    expect(l.expectedVersion).toBe(7);
    expect(l.zones.find((z) => z.key === 'zone-1')).toEqual(laydown);
    for (const z of l.zones.filter((z) => z.key !== 'zone-1')) expect(apart(z, laydown)).toBe(true);
    // Still everything the machines need, all of it on the site.
    expect(l.zones.map((z) => z.kind)).toEqual(expect.arrayContaining(['generator_room', 'maintenance_workshop', 'gate']));
    for (const z of l.zones) expect(inside(z, l)).toBe(true);
  });

  it('sends the generators to the generator room the user drew, under its own name, and adds no second one', () => {
    const room: ZoneInput = { key: 'zone-3', label: 'DG shed', kind: 'generator_room', x: 60, z: 30, widthM: 30, depthM: 20 };
    const l = composeAround([m('G1', 'Power Generation'), m('G2', 'Power Generation')], draft([room]), 0);
    expect(l.zones.filter((z) => z.kind === 'generator_room')).toEqual([room]);
    for (const id of ['G1', 'G2']) {
      const p = l.placements.find((x) => x.externalId === id)!;
      expect(holds(room, p.x, p.z)).toBe(true);
    }
  });

  it('keeps a drawn road section\'s reported progress instead of the composer\'s', () => {
    const roadB: ZoneInput = { key: 'road-b', label: 'NH section B', kind: 'road', x: 0, z: -40, widthM: 60, depthM: 12, progressPct: 70 };
    const l = composeAround([m('E1', EARTH), m('E2', EARTH), m('E3', EARTH)], draft([roadB]), 0);
    expect(l.zones.filter((z) => z.key === 'road-b')).toEqual([roadB]);
    // The excavators on the road front work along the road that is drawn.
    const onRoad = l.placements.filter((p) => p.route?.[0] === 'road-b');
    expect(onRoad.length).toBeGreaterThan(0);
    for (const p of onRoad) expect(holds(roadB, p.x, p.z)).toBe(true);
  });

  it('a drawn zone holding the composer\'s key for something else keeps it; the composer\'s takes a new key and the routes follow', () => {
    const notQuarry: ZoneInput = { key: 'quarry', label: 'Casting yard', kind: 'work_area', x: -70, z: 30, widthM: 30, depthM: 20 };
    const l = composeAround([
      m('E1', EARTH), m('E2', EARTH), m('E3', EARTH), m('E4', EARTH), m('B1', 'Concrete Equipment'), m('T1', 'Material Transport'),
    ], draft([notQuarry]), 0);
    expect(l.zones.find((z) => z.key === 'quarry')).toEqual(notQuarry);
    const quarry = l.zones.find((z) => z.kind === 'quarry')!;
    expect(quarry.key).toBe('quarry-2');
    expect(l.placements.find((p) => p.externalId === 'T1')!.route).toEqual(['quarry-2', 'batching-plant']);
    expect(new Set(l.zones.map((z) => z.key)).size).toBe(l.zones.length);
  });

  it('a site drawn full grows deeper for what it lacks; the drawing does not move', () => {
    const full: ZoneInput = { key: 'zone-1', label: 'Everything', kind: 'work_area', x: 0, z: 0, widthM: 160, depthM: 90 };
    const l = composeAround([m('G1', 'Power Generation')], draft([full], { widthM: 160, depthM: 90 }), 0);
    expect(l.zones[0]).toEqual(full);
    expect(l.extent.depthM).toBeGreaterThan(90);
    for (const z of l.zones.slice(1)) {
      expect(apart(z, full)).toBe(true);
      expect(inside(z, l)).toBe(true);
    }
  });

  it('an empty draft arranges as the composer always did, and the same draft gives the same layout', () => {
    const machines = [m('E1', EARTH), m('G1', 'Power Generation'), m('X1', null, true)];
    const empty = composeAround(machines, draft([], { widthM: 10, depthM: 10 }), 0);
    expect(empty).toEqual(composeLayout(machines, 0));
    expect(composeAround(machines, draft([laydown]), 0)).toEqual(composeAround(machines, draft([laydown]), 0));
  });
});

describeDb('auto-arrange around the draft, through POST /sites/:id/twin/proposal', () => {
  let owner: DataSource;
  let app: INestApplication;
  let plantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, {
      AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, AUTH_TENANT_CLAIM: 'client_id', CORS_ORIGINS: 'http://localhost:3000',
    });
    app = await createApp({ database: true });
    await app.init();
    for (const t of ['acme', 'globex']) await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1)`, [t]);
    [{ id: plantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'yard', 'Yard') RETURNING id`);
    for (const id of ['M1', 'M2']) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, plant_id, tier, readiness, updated_by)
           VALUES ('acme', $1, $2, $2, $3, 'standard', '{}'::jsonb, 'u')`, [SRC, id, plantId],
      );
    }
  }, 90_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const bearer = async (tenant: string) => `Bearer ${await app.get(JwtService).signAsync(
    { sub: '00000000-0000-4000-8000-0000000000c1', client_id: tenant, roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
  )}`;
  const propose = async (tenant: string, body: object) => request(app.getHttpServer())
    .post(`/api/v1/sites/${plantId}/twin/proposal`).set('Authorization', await bearer(tenant)).send(body);
  const laydown = { key: 'zone-1', label: 'Laydown', kind: 'material_yard', x: 0, z: 0, widthM: 24, depthM: 16 };

  it('answers 200 with the drawn zone kept, every machine placed, and a layout the database accepts', async () => {
    const res = await propose('acme', { extent: { widthM: 200, depthM: 120 }, zones: [laydown] });
    expect(res.status).toBe(200);
    expect(res.body.zones).toContainEqual(laydown);
    expect(res.body.placements.map((p: { externalId: string }) => p.externalId).sort()).toEqual(['M1', 'M2']);
    // Nothing is written by asking.
    expect(await owner.query(`SELECT 1 FROM site_twin_zone`)).toHaveLength(0);
    // Saved as proposed, the fit and route rules take it.
    await app.get(SiteTwinService).save(acme, plantId, res.body);
    expect((await owner.query(`SELECT label FROM site_twin_zone WHERE key = 'zone-1'`))).toEqual([{ label: 'Laydown' }]);
  });

  it('refuses a draft that is not a draft, and a site in another account', async () => {
    expect((await propose('acme', { extent: { widthM: 200, depthM: 120 }, zones: [{ ...laydown, kind: 'moon_base' }] })).status).toBe(400);
    expect((await propose('acme', { zones: [] })).status).toBe(400);
    expect((await propose('globex', { extent: { widthM: 200, depthM: 120 }, zones: [] })).status).toBe(404);
  });
});
