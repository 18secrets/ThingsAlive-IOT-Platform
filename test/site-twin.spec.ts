import { BadRequestException, ConflictException, INestApplication, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { PageService, twinStatus } from '../src/page/page.service';
import { LayoutInput, normaliseHeading, SiteTwinService } from '../src/site-twin/site-twin.service';
import { composeLayout, frontOf } from '../src/site-twin/compose';
import { ensureSiteTwinDemo, onboardTwinDemoMachines, tickSiteTwinDemo } from '../src/site-twin/site-twin-demo';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SiteTwin1763300000000';
const SECRET = 'test-secret-site-twin';
const ISSUER = 'things-alive-site-twin-test';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const SRC = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };

/**
 * The site's digital twin (layout tables, `GET /sites/:id/twin`, `PUT …/twin/layout`).
 *
 * The rules that keep the picture honest — nothing outside the site, nothing pushed off
 * it by a shrink, nothing pointing across accounts — are asserted by attempting each one
 * against the database. A layout save is versioned rather than idempotent, so its race
 * test asserts exactly one of two saves on the same version wins.
 */
describeDb('site twin: layout and live view', () => {
  let owner: DataSource;
  let app: INestApplication;
  let twins: SiteTwinService;
  let pages: PageService;
  let plantId: string;
  let otherPlantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    Object.assign(process.env, {
      AUTH_JWT_SECRET: SECRET, AUTH_JWT_ISSUER: ISSUER, AUTH_TENANT_CLAIM: 'client_id', CORS_ORIGINS: 'http://localhost:3000',
    });
    app = await createApp({ database: true });
    await app.init();
    twins = app.get(SiteTwinService);
    pages = app.get(PageService);

    await owner.query(`SELECT ensure_telemetry_partition('2026-10-01'::date)`);
    for (const t of ['acme', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [t]);
    }
    [{ id: plantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'yard', 'Yard') RETURNING id`);
    [{ id: otherPlantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'depot', 'Depot') RETURNING id`);

    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, name, status, expected_signals) VALUES ('gen', 1, 'gen', 'published', $1::jsonb)`,
      [JSON.stringify([{ signal: 'coolant', unit: 'x', required: true }])],
    );
    await owner.query(
      `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, min_count, stale_after_seconds)
         VALUES ('gen', 1, 'coolant', 'x', 1, 900)`,
    );
    const machine = (id: string, cls: string | null, plant = plantId) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, class_version, plant_id, tier, readiness, updated_by)
         VALUES ('acme', $1, $2, $2, $3, $4, $5, 'standard', '{}'::jsonb, 'u')`, [SRC, id, cls, cls ? 1 : null, plant],
    );
    await machine('DG-LIVE', 'gen');
    await machine('DG-SILENT', 'gen');
    await machine('BARE', null);
    await machine('ELSEWHERE', null, otherPlantId);
    // DG-LIVE also reports its engine on and working hard, through its own bindings: the
    // twin's activity is duty-cycle's classify over these, not a flag.
    for (const [role, value] of [['engine_running_status', 1], ['engine_load', 62]] as const) {
      await owner.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
           origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
         VALUES ('acme', $1, 'DG-LIVE', $2, $2, '', 'physical', 'imei-DG-LIVE', $2, 'x', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
        [SRC, role],
      );
      await owner.query(
        `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
           VALUES ('acme', 'imei-DG-LIVE', $1, $2, $3, $3, 'live')`, [role, value, new Date(NOW.getTime() - 120_000)],
      );
    }
    // An engine reading from an hour ago is older than any sample may speak for.
    await owner.query(
      `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
         origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
       VALUES ('acme', $1, 'DG-SILENT', 'engine_running_status', 'engine_running_status', '', 'physical', 'imei-DG-SILENT', 'e', 'x', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
      [SRC],
    );
    await owner.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
         VALUES ('acme', 'imei-DG-SILENT', 'engine_running_status', 1, $1, $1, 'live')`, [new Date(NOW.getTime() - 3_600_000)],
    );
    // DG-LIVE has a bound, fresh signal; DG-SILENT has the binding and nothing since.
    for (const [id, fresh] of [['DG-LIVE', true], ['DG-SILENT', false]] as const) {
      await owner.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
           origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
         VALUES ('acme', $1, $2, 'coolant', 'coolant', '', 'physical', $3, 'ch0', 'x', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
        [SRC, id, `imei-${id}`],
      );
      if (fresh) {
        await owner.query(
          `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
             VALUES ('acme', $1, 'coolant', 1, $2, $2, 'live')`, [`imei-${id}`, new Date(NOW.getTime() - 60_000)],
        );
      }
    }
  }, 90_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const layout = (over: Partial<LayoutInput> = {}): LayoutInput => ({
    expectedVersion: 0,
    extent: { widthM: 100, depthM: 60 },
    zones: [{ key: 'batching', label: 'Batching yard', kind: 'work_area', x: -30, z: 0, widthM: 30, depthM: 20 }],
    placements: [{ sourceSystem: SRC, externalId: 'DG-LIVE', x: -30, z: 0, headingDeg: 90 }],
    ...over,
  });

  describe('before anyone draws it', () => {
    it('is a default yard with every machine unplaced and its status from the site page reads', async () => {
      const view = await pages.siteTwin(acme, plantId, NOW);
      expect(view).toMatchObject({ saved: false, version: 0, extent: { widthM: 200, depthM: 120 }, zones: [] });
      // Only the seed demo account's twin is a simulation; a real account's never is.
      expect(view.simulated).toBe(false);
      const status = Object.fromEntries(view.machines.map((m) => [m.externalId, m.status]));
      // The machine at another site is not drawn here.
      expect(status).toEqual({ BARE: 'not_configured', 'DG-LIVE': 'live', 'DG-SILENT': 'no_data' });
      expect(view.machines.every((m) => m.placement === null)).toBe(true);
      expect(view.summary).toMatchObject({ total: 3, placed: 0, live: 1, no_data: 1, not_configured: 1 });
      // No model is uploaded for `gen`: the class is listed, as null, so the UI draws a block.
      expect(view.classModels).toEqual({ gen: null });
    });
  });

  describe('saving', () => {
    it('stores the layout, bumps the version and answers with the live view', async () => {
      await twins.save(acme, plantId, layout());
      const view = await pages.siteTwin(acme, plantId, NOW);
      expect(view).toMatchObject({ saved: true, version: 1, extent: { widthM: 100, depthM: 60 } });
      expect(view.zones).toEqual([expect.objectContaining({ key: 'batching', label: 'Batching yard', kind: 'work_area' })]);
      expect(view.machines.find((m) => m.externalId === 'DG-LIVE')!.placement).toEqual({ x: -30, z: 0, headingDeg: 90, route: [] });
      expect(view.summary.placed).toBe(1);
    });

    it('says what each machine is doing from its own signals, and which zone it is engaged at', async () => {
      const view = await pages.siteTwin(acme, plantId, NOW);
      const by = Object.fromEntries(view.machines.map((m) => [m.externalId, m]));
      expect(by['DG-LIVE']).toMatchObject({ activity: 'productive', engagedAt: 'batching' });
      // Engine on an hour ago says nothing about now: unknown, never off and never working.
      expect(by['DG-SILENT']).toMatchObject({ activity: 'unknown', engagedAt: null });
      expect(by.BARE.activity).toBe('unknown');
    });

    it('refuses a save drawn on a version someone has since replaced', async () => {
      await expect(twins.save(acme, plantId, layout({ expectedVersion: 0 }))).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a machine that is not at this site, and one placed twice', async () => {
      const elsewhere = { sourceSystem: SRC, externalId: 'ELSEWHERE', x: 0, z: 0, headingDeg: 0 };
      await expect(twins.save(acme, plantId, layout({ expectedVersion: 1, placements: [elsewhere] })))
        .rejects.toThrow(/not a machine at this site/);
      const twice = { sourceSystem: SRC, externalId: 'BARE', x: 0, z: 0, headingDeg: 0 };
      await expect(twins.save(acme, plantId, layout({ expectedVersion: 1, placements: [twice, twice] })))
        .rejects.toThrow(/placed twice/);
      // Neither refusal moved the version.
      expect((await twins.read(acme, plantId)).version).toBe(1);
    });

    it('lets two saves on the same version race, and exactly one of them win', async () => {
      const results = await Promise.allSettled([
        twins.save(acme, plantId, layout({ expectedVersion: 1, zones: [] })),
        twins.save(acme, plantId, layout({ expectedVersion: 1, zones: [] })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ConflictException);
      expect((await twins.read(acme, plantId)).version).toBe(2);
    });

    it('stores a heading as [0, 360), whatever the drag wound up to', () => {
      expect([normaliseHeading(360), normaliseHeading(-90), normaliseHeading(725)]).toEqual([0, 270, 5]);
    });

    it('lets a user scoped to some machines save their part without erasing the rest', async () => {
      await twins.save(acme, plantId, layout({
        expectedVersion: 2,
        placements: [
          { sourceSystem: SRC, externalId: 'DG-LIVE', x: 10, z: 10, headingDeg: 0 },
          { sourceSystem: SRC, externalId: 'BARE', x: 20, z: 10, headingDeg: 0 },
        ],
      }));
      const narrow: RequestScope = { ...acme, equipmentIds: ['BARE'] };
      await twins.save(narrow, plantId, layout({ expectedVersion: 3, placements: [{ sourceSystem: SRC, externalId: 'BARE', x: -40, z: -20, headingDeg: 0 }] }));
      const view = await pages.siteTwin(acme, plantId, NOW);
      const at = Object.fromEntries(view.machines.map((m) => [m.externalId, m.placement]));
      expect(at['DG-LIVE']).toMatchObject({ x: 10, z: 10 });
      expect(at.BARE).toMatchObject({ x: -40, z: -20 });
    });
  });

  describe('progress and routes', () => {
    const base = async () => (await twins.read(acme, plantId)).version;
    const block = { key: 'block-a', label: 'Block A', kind: 'building' as const, x: 20, z: -10, widthM: 20, depthM: 16, floors: 6 };

    it('dates progress when it is reported, and keeps that date while the figure is unchanged', async () => {
      const t1 = new Date('2026-10-14T09:00:00Z');
      await twins.save(acme, plantId, layout({ expectedVersion: await base(), zones: [{ ...block, progressPct: 30 }], placements: [] }), t1);
      await twins.save(acme, plantId, layout({ expectedVersion: await base(), zones: [{ ...block, progressPct: 30 }], placements: [] }), NOW);
      let zone = (await twins.read(acme, plantId)).zones[0];
      expect(zone).toMatchObject({ progressPct: 30, progressReportedAt: t1.toISOString(), progressReportedBy: 'u-acme', floors: 6 });

      const v = await base();
      await twins.reportProgress(acme, plantId, 'block-a', 45, NOW);
      const after = await twins.read(acme, plantId);
      zone = after.zones[0];
      expect(zone).toMatchObject({ progressPct: 45, progressReportedAt: NOW.toISOString() });
      // It bumps the layout version, so an editor holding the old picture cannot save over it.
      expect(after.version).toBe(v + 1);
      await expect(twins.save(acme, plantId, layout({ expectedVersion: v, zones: [], placements: [] }))).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses progress on something not built in stages, and a percentage with no date', async () => {
      await twins.save(acme, plantId, layout({
        expectedVersion: await base(), placements: [],
        zones: [block, { key: 'gate', label: 'Gate', kind: 'gate', x: -40, z: 20, widthM: 8, depthM: 8 }],
      }));
      await expect(twins.reportProgress(acme, plantId, 'gate', 50)).rejects.toThrow(/not built in stages/);
      await expect(owner.query(`UPDATE site_twin_zone SET progress_pct = 10 WHERE key = 'block-a' AND plant_id = $1`, [plantId]))
        .rejects.toThrow(/ck_site_twin_zone_progress/);
      await expect(owner.query(
        `UPDATE site_twin_zone SET progress_pct = 10, progress_reported_at = now() WHERE key = 'gate' AND plant_id = $1`, [plantId],
      )).rejects.toThrow(/ck_site_twin_zone_progress/);
      await expect(owner.query(`UPDATE site_twin_zone SET floors = 3 WHERE key = 'gate' AND plant_id = $1`, [plantId]))
        .rejects.toThrow(/ck_site_twin_zone_floors/);
    });

    it('stores a route between zones, and refuses one naming a zone that is not there', async () => {
      const zones = [block, { key: 'gate', label: 'Gate', kind: 'gate' as const, x: -40, z: 20, widthM: 8, depthM: 8 }];
      await twins.save(acme, plantId, layout({
        expectedVersion: await base(), zones,
        placements: [{ sourceSystem: SRC, externalId: 'DG-LIVE', x: 0, z: 0, headingDeg: 0, route: ['gate', 'block-a'] }],
      }));
      const view = await pages.siteTwin(acme, plantId, NOW);
      expect(view.machines.find((m) => m.externalId === 'DG-LIVE')!.placement!.route).toEqual(['gate', 'block-a']);

      // Checked at commit: the save deletes and re-inserts the zones the route names.
      const dangling = twins.save(acme, plantId, layout({
        expectedVersion: await base(), zones,
        placements: [{ sourceSystem: SRC, externalId: 'DG-LIVE', x: 0, z: 0, headingDeg: 0, route: ['gate', 'jetty'] }],
      }));
      await expect(dangling).rejects.toBeInstanceOf(BadRequestException);
      await expect(dangling).rejects.toThrow(/ck_site_twin_route/);
      // And removing a zone a kept route still names is refused the same way.
      await expect(owner.query(`DELETE FROM site_twin_zone WHERE key = 'gate' AND plant_id = $1`, [plantId]))
        .rejects.toThrow(/ck_site_twin_route/);
    });

    it('puts the layout back the way the refusal tests below expect it', async () => {
      await twins.save(acme, plantId, layout({
        expectedVersion: await base(),
        placements: [
          { sourceSystem: SRC, externalId: 'DG-LIVE', x: 10, z: 10, headingDeg: 0 },
          { sourceSystem: SRC, externalId: 'BARE', x: -40, z: -20, headingDeg: 0 },
        ],
      }));
    });
  });

  describe('only plant the site has', () => {
    const room = { key: 'gen-room', label: 'Generator room', kind: 'generator_room' as const, x: 30, z: 15, widthM: 16, depthM: 10 };

    it('refuses a generator room on a site with no generator assigned', async () => {
      const v = (await twins.read(acme, plantId)).version;
      await expect(twins.save(acme, plantId, layout({ expectedVersion: v, zones: [room], placements: [] })))
        .rejects.toThrow(/needs a generator assigned to this site/);
    });

    it('accepts it once one is, and stops drawing it when the generator leaves', async () => {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, plant_id, tier, readiness, updated_by)
           VALUES ('acme', $1, 'GEN-1', 'Genset', 'prime-diesel-generator', $2, 'standard', '{}'::jsonb, 'u')`, [SRC, plantId],
      );
      const v = (await twins.read(acme, plantId)).version;
      await twins.save(acme, plantId, layout({ expectedVersion: v, zones: [room], placements: [] }));
      expect((await pages.siteTwin(acme, plantId, NOW)).zones.map((z) => z.key)).toEqual(['gen-room']);

      await owner.query(`UPDATE equipment_profile SET plant_id = $1 WHERE external_id = 'GEN-1'`, [otherPlantId]);
      const view = await pages.siteTwin(acme, plantId, NOW);
      expect(view.zones).toEqual([]);
      expect(view.hiddenZones).toEqual(['gen-room']);
      await owner.query(`DELETE FROM equipment_profile WHERE external_id = 'GEN-1'`);
    });

    it('sends a machine with an open breakdown to the breakdown bay in the proposal', async () => {
      await owner.query(
        `INSERT INTO breakdown_event (tenant_id, source_system, external_id, started_at, threshold_minutes, detected_from)
           VALUES ('acme', $1, 'BARE', $2, 30, '{"by":"test"}'::jsonb)`, [SRC, new Date(NOW.getTime() - 7_200_000)],
      );
      const view = await pages.siteTwin(acme, plantId, NOW);
      expect(view.machines.find((m) => m.externalId === 'BARE')!.breakdown).toBe(true);
      const proposal = await pages.siteTwinProposal(acme, plantId, NOW);
      const bay = proposal.zones.find((z) => z.key === 'workshop')!;
      const bare = proposal.placements.find((p) => p.externalId === 'BARE')!;
      expect(Math.abs(bare.x - bay.x) <= bay.widthM / 2 && Math.abs(bare.z - bay.z) <= bay.depthM / 2).toBe(true);
      // DG-SILENT has no recent data: the bay too. DG-LIVE, ready, goes elsewhere.
      expect(proposal.placements.map((p) => p.externalId).sort()).toEqual(['BARE', 'DG-LIVE', 'DG-SILENT']);
      // The proposal saves as it stands: everything in it is backed and fits.
      await expect(twins.save(acme, plantId, proposal)).resolves.toBeDefined();
      // Breakdowns are kept, never deleted: close it, and the machine is no longer broken down.
      await owner.query(
        `UPDATE breakdown_event SET ended_at = started_at + interval '60 minutes', duration_minutes = 60 WHERE external_id = 'BARE'`,
      );
      expect((await pages.siteTwin(acme, plantId, NOW)).machines.find((m) => m.externalId === 'BARE')!.breakdown).toBe(false);
    });

    it('puts the layout back the way the refusal tests below expect it', async () => {
      await twins.save(acme, plantId, layout({
        expectedVersion: (await twins.read(acme, plantId)).version,
        placements: [
          { sourceSystem: SRC, externalId: 'DG-LIVE', x: 10, z: 10, headingDeg: 0 },
          { sourceSystem: SRC, externalId: 'BARE', x: -40, z: -20, headingDeg: 0 },
        ],
      }));
    });
  });

  describe('the database refuses a picture that is not true', () => {
    it('refuses a zone that runs past the edge of the site', async () => {
      const v = (await twins.read(acme, plantId)).version;
      const over = { key: 'spill', label: 'Spill', kind: 'material_yard' as const, x: 45, z: 0, widthM: 20, depthM: 10 };
      // Through the service it is a 400 carrying the database's own reason.
      const saving = twins.save(acme, plantId, layout({ expectedVersion: v, zones: [over], placements: [] }));
      await expect(saving).rejects.toBeInstanceOf(BadRequestException);
      await expect(saving).rejects.toThrow(/ck_site_twin_fits/);
      await expect(owner.query(
        `INSERT INTO site_twin_zone (tenant_id, plant_id, key, label, kind, x, z, width_m, depth_m) VALUES ('acme', $1, 'spill', 'Spill', 'parking', 45, 0, 20, 10)`,
        [plantId],
      )).rejects.toThrow(/ck_site_twin_fits/);
    });

    it('refuses a machine placed outside the site', async () => {
      await expect(owner.query(
        `INSERT INTO site_twin_placement (tenant_id, plant_id, source_system, external_id, x, z) VALUES ('acme', $1, $2, 'DG-SILENT', 0, 31)`,
        [plantId, SRC],
      )).rejects.toThrow(/ck_site_twin_fits/);
    });

    it('refuses shrinking the site until a placed machine falls off it', async () => {
      // BARE stands at (-40, -20) on a 100 x 60 site; 70 m wide leaves it 5 m outside.
      await expect(owner.query(`UPDATE site_twin SET width_m = 70 WHERE plant_id = $1`, [plantId]))
        .rejects.toThrow(/ck_site_twin_fits/);
    });

    it('refuses a zone kind outside the legend, and a heading of 360', async () => {
      await expect(owner.query(
        `INSERT INTO site_twin_zone (tenant_id, plant_id, key, label, kind, x, z, width_m, depth_m) VALUES ('acme', $1, 'pit', 'Pit', 'helipad', 0, 0, 5, 5)`,
        [plantId],
      )).rejects.toThrow(/ck_site_twin_zone_kind/);
      await expect(owner.query(
        `INSERT INTO site_twin_placement (tenant_id, plant_id, source_system, external_id, x, z, heading_deg) VALUES ('acme', $1, $2, 'DG-SILENT', 0, 0, 360)`,
        [plantId, SRC],
      )).rejects.toThrow(/ck_site_twin_placement_heading/);
    });

    it("refuses one account's twin pointing at another account's site", async () => {
      await expect(owner.query(
        `INSERT INTO site_twin (tenant_id, plant_id, width_m, depth_m) VALUES ('globex', $1, 100, 100)`, [plantId],
      )).rejects.toThrow(/fk_site_twin_plant/);
    });
  });

  describe('scope and HTTP', () => {
    const token = (tenant: string, roles: string[]) => app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000c1', client_id: tenant, roles }, { secret: SECRET, issuer: ISSUER },
    );

    it('is not found from another account, and from a site outside the caller\'s scope', async () => {
      await expect(pages.siteTwin(globex, plantId, NOW)).rejects.toBeInstanceOf(NotFoundException);
      await expect(twins.save(globex, plantId, layout())).rejects.toBeInstanceOf(NotFoundException);
      await expect(pages.siteTwin({ ...acme, plantIds: [otherPlantId] }, plantId, NOW)).rejects.toBeInstanceOf(NotFoundException);
      const res = await request(app.getHttpServer()).get(`/api/v1/sites/${plantId}/twin`)
        .set('Authorization', `Bearer ${await token('globex', ['admin'])}`);
      expect(res.status).toBe(404);
    });

    it('serves the twin to a reader, and refuses a save to one without equipment.write', async () => {
      const operator = `Bearer ${await token('acme', ['operational'])}`;
      const got = await request(app.getHttpServer()).get(`/api/v1/sites/${plantId}/twin`).set('Authorization', operator);
      expect(got.status).toBe(200);
      expect(got.body.site).toMatchObject({ plantId, code: 'yard' });
      const put = await request(app.getHttpServer()).put(`/api/v1/sites/${plantId}/twin/layout`)
        .set('Authorization', operator).send({ ...layout(), expectedVersion: got.body.version });
      expect(put.status).toBe(403);
    });

    it('saves over HTTP for an admin, and answers a stale version with 409', async () => {
      const admin = `Bearer ${await token('acme', ['admin'])}`;
      const { body } = await request(app.getHttpServer()).get(`/api/v1/sites/${plantId}/twin`).set('Authorization', admin);
      const ok = await request(app.getHttpServer()).put(`/api/v1/sites/${plantId}/twin/layout`)
        .set('Authorization', admin).send({ ...layout(), expectedVersion: body.version });
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(body.version + 1);
      const stale = await request(app.getHttpServer()).put(`/api/v1/sites/${plantId}/twin/layout`)
        .set('Authorization', admin).send({ ...layout(), expectedVersion: body.version });
      expect(stale.status).toBe(409);
      const bad = await request(app.getHttpServer()).put(`/api/v1/sites/${plantId}/twin/layout`)
        .set('Authorization', admin).send({ ...layout(), expectedVersion: ok.body.version, zones: [{ key: 'x', label: 'x', kind: 'helipad', x: 0, z: 0, widthM: 5, depthM: 5 }] });
      expect(bad.status).toBe(400);
    });
  });

  describe('composing a layout from the assigned machines', () => {
    const m = (externalId: string, category: string | null, classSlug: string | null = null, attention = false) =>
      ({ sourceSystem: SRC, externalId, category, classSlug, attention });
    const kinds = (l: LayoutInput) => l.zones.map((z) => z.kind);

    it('reads the work front from the category, and from the slug where there is none', () => {
      expect(frontOf({ category: 'Power Generation', classSlug: null })).toBe('power');
      expect(frontOf({ category: null, classSlug: 'screw-air-compressor' })).toBe('pneumatic');
      expect(frontOf({ category: 'Excavators & Earthmoving', classSlug: 'hydraulic-excavator' })).toBe('earthmoving');
    });

    it('gives excavators a road front and a quarry, and no plant they do not need', () => {
      const l = composeLayout(['E1', 'E2', 'E3', 'E4', 'E5', 'E6'].map((id) => m(id, 'Excavators & Earthmoving')), 0);
      expect(kinds(l)).toEqual(expect.arrayContaining(['road', 'quarry', 'gate', 'maintenance_workshop']));
      for (const k of ['generator_room', 'compressor_house', 'batching_plant', 'building']) expect(kinds(l)).not.toContain(k);
      // The road in sections: one laid, one started, one not yet.
      expect(l.zones.filter((z) => /^road-/.test(z.key)).map((z) => z.progressPct)).toEqual([100, 45, 0]);
      const onRoad = l.placements.filter((p) => p.route?.length);
      expect(onRoad.length).toBeGreaterThan(0);
      expect(onRoad[0].route).toEqual(['road-b', 'road-c']);
    });

    it('adds a generator room and a compressor house only for a generator and a compressor', () => {
      const l = composeLayout([m('G', 'Power Generation'), m('C', 'Pneumatic Systems')], 0);
      expect(kinds(l)).toEqual(expect.arrayContaining(['generator_room', 'compressor_house']));
      expect(kinds(l)).not.toContain('quarry');
    });

    it('sends tippers between the fronts the site has, and gives piling rigs their own area', () => {
      const l = composeLayout([
        m('E1', 'Excavators & Earthmoving'), m('E2', 'Excavators & Earthmoving'), m('E3', 'Excavators & Earthmoving'),
        m('E4', 'Excavators & Earthmoving'), m('B1', 'Concrete Equipment'), m('T1', 'Material Transport'),
        m('T2', 'Material Transport'), m('P1', 'Foundation & Drilling'),
      ], 0);
      expect(l.placements.find((p) => p.externalId === 'T1')!.route).toEqual(['quarry', 'batching-plant']);
      expect(kinds(l)).toContain('batching_plant');
      expect(l.zones.find((z) => z.key === 'piling')).toBeDefined();
      expect(kinds(l)).not.toContain('building');
    });

    it('sizes a zone to its machines: eleven generators get eleven spots, none shared, all inside', () => {
      const l = composeLayout(Array.from({ length: 11 }, (_, i) => m(`G${i}`, 'Power Generation')), 0);
      const room = l.zones.find((z) => z.key === 'generator-room')!;
      const spots = l.placements.map((p) => `${p.x},${p.z}`);
      expect(new Set(spots).size).toBe(11);
      for (const p of l.placements) {
        expect(Math.abs(p.x - room.x)).toBeLessThanOrEqual(room.widthM / 2);
        expect(Math.abs(p.z - room.z)).toBeLessThanOrEqual(room.depthM / 2);
      }
      // Nothing composed falls outside the site, so the database will accept it.
      for (const z of l.zones) {
        expect(Math.abs(z.x) + z.widthM / 2).toBeLessThanOrEqual(l.extent.widthM / 2);
        expect(Math.abs(z.z) + z.depthM / 2).toBeLessThanOrEqual(l.extent.depthM / 2);
      }
    });

    it('puts a machine that needs attention in the breakdown bay, not at its work front', () => {
      const l = composeLayout([m('E1', 'Excavators & Earthmoving', null, true)], 0);
      const bay = l.zones.find((z) => z.key === 'workshop')!;
      expect(l.placements).toEqual([expect.objectContaining({ externalId: 'E1', x: bay.x, z: bay.z })]);
    });
  });

  it('the demo stream lays out only sites with machines, and never one already laid out', async () => {
    const [{ id: empty }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'empty', 'Empty') RETURNING id`);
    const before = (await twins.read(acme, plantId)).version;
    await ensureSiteTwinDemo(owner, 'acme');
    await tickSiteTwinDemo(owner, 'acme', NOW, { writeLoad: false });
    expect((await twins.read(acme, plantId)).version).toBe(before);
    const depot = await twins.read(acme, otherPlantId);
    expect(depot.saved).toBe(true);
    expect([...depot.placements.keys()]).toEqual([`${SRC}/ELSEWHERE`]);
    expect((await twins.read(acme, empty)).saved).toBe(false);

    // A machine assigned to the demo-made site: re-composed, the new one placed.
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, plant_id, tier, readiness, updated_by)
         VALUES ('acme', $1, 'GEN-9', 'Genset', 'prime-diesel-generator', $2, 'standard', '{}'::jsonb, 'u')`, [SRC, otherPlantId],
    );
    await ensureSiteTwinDemo(owner, 'acme');
    const again = await twins.read(acme, otherPlantId);
    expect([...again.placements.keys()].sort()).toEqual([`${SRC}/ELSEWHERE`, `${SRC}/GEN-9`]);
    expect(again.zones.map((z) => z.key)).toContain('generator-room');
    // Nothing changed since: left alone.
    await ensureSiteTwinDemo(owner, 'acme');
    expect((await twins.read(acme, otherPlantId)).version).toBe(again.version);
    await owner.query(`DELETE FROM equipment_profile WHERE external_id = 'GEN-9'`);
  });

  it('sets up the named test machines: a class where none, every required role bound, readings that make them live', async () => {
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, name, status, expected_signals) VALUES ('demo-excavator', 1, 'demo', 'published', $1::jsonb)`,
      [JSON.stringify([{ signal: 'engine_running_status', unit: 'x', required: true }, { signal: 'engine_load', unit: 'x', required: true }])],
    );
    for (const role of ['engine_running_status', 'engine_load']) {
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, min_count, stale_after_seconds)
           VALUES ('demo-excavator', 1, $1, 'x', 1, 3600)`, [role],
      );
    }
    await owner.query(
      `INSERT INTO client_equipment_class (tenant_id, slug, name, template_slug, template_version) VALUES ('acme', 'demo-excavator', 'Demo', 'demo-excavator', 1)`,
    );
    const [{ id: yard }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'test-yard', 'Test yard') RETURNING id`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, plant_id, tier, readiness, updated_by)
         VALUES ('acme', $1, 'TEST-DIPPY-NOLIB-01', 'No library', $2, 'standard', '{}'::jsonb, 'u')`, [SRC, yard],
    );
    await onboardTwinDemoMachines(owner, 'acme', NOW);
    await onboardTwinDemoMachines(owner, 'acme', NOW); // twice: no second binding
    const [machine] = await owner.query(`SELECT equipment_class_slug FROM equipment_profile WHERE external_id = 'TEST-DIPPY-NOLIB-01'`);
    expect(machine.equipment_class_slug).toBe('demo-excavator');
    const bound = await owner.query(`SELECT measurement_role FROM signal_binding_version WHERE external_id = 'TEST-DIPPY-NOLIB-01' ORDER BY 1`);
    expect(bound.map((b: { measurement_role: string }) => b.measurement_role)).toEqual(['engine_load', 'engine_running_status']);
    const view = await pages.siteTwin(acme, yard, NOW);
    expect(view.machines[0]).toMatchObject({ externalId: 'TEST-DIPPY-NOLIB-01', status: 'live', activity: 'productive' });
  });

  it('the port overview draws every laid-out site in scope, lists the rest, and has no workforce on a real account', async () => {
    const port = await pages.portTwin(acme, NOW);
    expect(port.simulated).toBe(false);
    expect(port.summary.workforce).toBeNull();
    const codes = port.sites.map((s) => s.site.code);
    expect(codes).toContain('yard');
    for (const s of port.sites) expect(s.saved).toBe(true);
    expect(port.summary.machines).toBe(port.sites.reduce((a, s) => a + s.summary.total, 0));
    // Scope narrows it like every other site read.
    const narrow = await pages.portTwin({ ...acme, plantIds: [plantId] }, NOW);
    expect(narrow.sites.map((s) => s.site.plantId)).toEqual([plantId]);
    expect((await pages.portTwin(globex, NOW)).sites).toEqual([]);
  });

  it('draws an open alert as an alert, whatever the readiness', () => {
    expect(twinStatus('ready', 2)).toBe('alert');
    expect(twinStatus('blocked', 0)).toBe('blocked');
    expect(twinStatus('not_available', 0)).toBe('no_data');
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'site_twin%'`);
    expect(n).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    const [{ m }] = await owner.query(`SELECT count(*)::int AS m FROM pg_tables WHERE tablename LIKE 'site_twin%'`);
    expect(m).toBe(3);
  });
});
