import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  DemoMobility, demoMobility, demoMovement, demoNoGoZone, demoPosition, demoSiteBoundary, demoSiteCentre, DemoMovement,
  topUpDemoPositions,
} from '../src/database/seeds/demo-geofence';
import { FleetStatusService } from '../src/geofence/fleet-status.service';
import { GeofenceTracker } from '../src/geofence/geofence-tracker.service';
import { haversineM, insideZone, LngLat } from '../src/geofence/geometry';
import { createApp } from '../src/main';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-geofence-fleet';
const ISSUER = 'things-alive-geofence-fleet-test';
const STEP_MS = 10 * 60_000;
const IST = 5.5 * 3_600_000;
/** A UTC instant at a given India time on 29 Oct 2026. */
const istAt = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 29, hour, minute) - IST);

/** The first of GEO-1, GEO-2, … whose simulated movement is `kind`, so tests do not hard-code the hash. */
const machineThat = (kind: DemoMovement, nth = 0, mobility: DemoMobility = 'working') => {
  let seen = 0;
  for (let i = 1; i < 500; i += 1) {
    if (demoMovement(`GEO-${i}`, mobility) === kind && seen++ === nth) return `GEO-${i}`;
  }
  throw new Error(`no machine id gives ${kind}`);
};

/** The fleet map and the demo's simulated GPS, end to end (task QGEO2). */
describe('QGEO2: the demo\'s simulated movement', () => {
  const centre = demoSiteCentre('VIZAG');
  const boundary = demoSiteBoundary(centre);
  const noGo = demoNoGoZone(centre);
  const TIPPER = 'rock-tipper-truck Rock Tipper Truck ROCK BODY TIPPER - 35 MT';
  const DG = 'prime-diesel-generator Prime Diesel Generator Diesel Generator Set 500 KVA';
  const EXCAVATOR = 'hydraulic-excavator Hydraulic Excavator';
  /** Positions every `stepS` seconds across India-time hours [from, to). */
  const track = (id: string, type: string, from: number, to: number, stepS = 20): LngLat[] => {
    const out: LngLat[] = [];
    for (let t = istAt(from).getTime(); t < istAt(to).getTime(); t += stepS * 1000) out.push(demoPosition(id, centre, t, type));
    return out;
  };
  const farthest = (ps: LngLat[]) => Math.max(...ps.map((p) => haversineM(ps[0], p)));

  it('reads what a machine is from the demo account\'s own types', () => {
    const cases: [string, DemoMobility][] = [
      ['rock-tipper-truck', 'mobile'], ['motor-grader', 'mobile'],
      ['hydraulic-excavator', 'working'], ['backhoe-loader', 'working'], ['heavy-crawler-crane', 'working'],
      ['truck-mounted-crane', 'working'], ['rotary-piling-rig', 'working'], ['vibro-hammer', 'working'],
      ['prime-diesel-generator', 'stationary'], ['concrete-pump', 'stationary'], ['concrete-placer-boom', 'stationary'],
      ['screw-air-compressor', 'stationary'], ['shutter-converter', 'stationary'], ['something-new', 'working'],
    ];
    for (const [slug, mobility] of cases) expect([slug, demoMobility(slug)]).toEqual([slug, mobility]);
  });

  it('a generator stays where it was set down, all day, within a GPS fix\'s few metres', () => {
    for (const id of ['GEO-1', 'GEO-2', 'GEO-3', 'GEO-4', 'GEO-5']) {
      const day = track(id, DG, 0, 24, 300);
      expect(farthest(day)).toBeLessThan(10);
      expect(day.every((p) => insideZone(boundary, p) && !insideZone(noGo, p))).toBe(true);
    }
  });

  it('an excavator works within about a hundred metres of its spot, at walking pace at most', () => {
    const id = machineThat('on_site', 0, 'working');
    const day = track(id, EXCAVATOR, 0, 24, 60);
    expect(farthest(day)).toBeGreaterThan(20);
    expect(farthest(day)).toBeLessThan(160);
    for (let i = 1; i < day.length; i += 1) expect(haversineM(day[i - 1], day[i]) / 60 * 3.6).toBeLessThan(6); // km/h
  });

  it('a tipper hauls: parked at the loading point, then a loop of a few km at road speed, inside the site', () => {
    const id = machineThat('on_site', 0, 'mobile');
    const hour = track(id, TIPPER, 8, 9);
    const speeds = hour.slice(1).map((p, i) => (haversineM(hour[i], p) / 20) * 3.6);
    const moving = speeds.filter((v) => v > 3);
    expect(moving.length).toBeGreaterThan(hour.length * 0.4);
    expect(Math.max(...moving)).toBeLessThan(40);
    expect(moving.reduce((a, v) => a + v, 0) / moving.length).toBeGreaterThan(10);
    expect(speeds.filter((v) => v < 1).length).toBeGreaterThan(hour.length * 0.25); // parked, loading
    expect(hour.every((p) => insideZone(boundary, p) && !insideZone(noGo, p))).toBe(true);
  });

  it('a tipper on a haul trip is off site from 13:00 to 15:00 India time, out and back', () => {
    const id = machineThat('leaves_site', 0, 'mobile');
    expect(insideZone(boundary, demoPosition(id, centre, istAt(14).getTime(), TIPPER))).toBe(false);
    expect(insideZone(boundary, demoPosition(id, centre, istAt(15, 30).getTime(), TIPPER))).toBe(true);
  });

  it('a trespasser stands in the no-go area from 10:00 to 11:00; a generator or pump never does, and never leaves', () => {
    const id = machineThat('enters_no_go');
    expect(insideZone(noGo, demoPosition(id, centre, istAt(10, 20).getTime(), EXCAVATOR))).toBe(true);
    expect(insideZone(noGo, demoPosition(id, centre, istAt(12).getTime(), EXCAVATOR))).toBe(false);
    for (let i = 1; i < 60; i += 1) {
      for (const type of [DG, 'concrete-pump']) {
        for (const at of [istAt(10, 20), istAt(14)]) {
          const p = demoPosition(`GEO-${i}`, centre, at.getTime(), type);
          expect(insideZone(boundary, p) && !insideZone(noGo, p)).toBe(true);
        }
      }
    }
  });
});

describeDb('QGEO2: fleet map, end to end', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let fleet: FleetStatusService;
  let tracker: GeofenceTracker;
  let siteId: string;
  let otherSiteId: string;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const ON_SITE = machineThat('on_site');
  const TRESPASSER = machineThat('enters_no_go');
  // On another site, and working: its movement must not add a violation of its own.
  const ELSEWHERE = machineThat('on_site', 1);
  const imeiOf = (id: string) => `IMEI-${id}`;
  const NOW = istAt(10, 30); // the trespasser's hour

  const fitLogger = async (externalId: string, plantId: string | null) => {
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
         VALUES ('acme', 'ta-2.0', $1, $1, 'client', 'active', 'basic', '{}'::jsonb, $2)`,
      [externalId, plantId],
    );
    await owner.query(
      `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ($1, 'acme', 'assigned', $2)`,
      [imeiOf(externalId), externalId],
    );
    await owner.getRepository(SignalBindingVersion).save({
      tenantId: 'acme', sourceSystem: 'ta-2.0', externalId, signalKey: 'engine_load', measurementRole: 'engine_load',
      componentId: '', origin: 'physical', imei: imeiOf(externalId), channel: 'engine_load', sensorInstanceId: null,
      canonicalUnit: '%', sourceUnit: null, validFrom: new Date('2026-01-01'), validTo: null, expectedPeriodSeconds: 600,
      isPrimary: true, status: 'active', discoveredFrom: null, discoveredBy: 'manual', approvedBy: 'u', approvedAt: NOW,
    });
  };
  /** The logger said something recently: the machine is online. */
  const reported = (externalId: string, at: Date) => owner.query(
    `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
       VALUES ('acme', $1, 'engine_load', 50, '%', $2, $2, 'simulated')`,
    [imeiOf(externalId), at],
  );

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    await owner.query(`SELECT ensure_telemetry_partition('2026-10-01'::date)`);
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    fleet = app.get(FleetStatusService);
    tracker = app.get(GeofenceTracker);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "geofence_visit", "geofence_zone", "domain_event", "telemetry_reading",
      "signal_binding_version", "device_inventory", "equipment_profile", "plant" CASCADE`);
    [{ id: siteId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'VIZAG', 'Vizag yard') RETURNING id`);
    [{ id: otherSiteId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'PUNE', 'Pune yard') RETURNING id`);
    await fitLogger(ON_SITE, siteId);
    await fitLogger(TRESPASSER, siteId);
    await fitLogger('ASLEEP', siteId); // fitted, but its logger has not reported in a day
    await fitLogger(ELSEWHERE, otherSiteId);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('acme', 'ta-2.0', 'NO-LOGGER', 'No logger', 'client', 'active', 'basic', '{}'::jsonb)`,
    );
    for (const id of [ON_SITE, TRESPASSER, ELSEWHERE]) await reported(id, new Date(NOW.getTime() - 5 * 60_000));
    await reported('ASLEEP', new Date(NOW.getTime() - 30 * 3_600_000));
  });

  const topUp = (now = NOW) => topUpDemoPositions(ds, { tenantId: 'acme', stepMs: STEP_MS, now });

  it('the position top-up draws the fences once, and writes positions only for machines that are online', async () => {
    const first = await topUp();
    expect({ boundaries: first.boundaries, zones: first.zones }).toEqual({ boundaries: 2, zones: 2 });
    expect(Object.keys(first.positions).sort()).toEqual([ELSEWHERE, ON_SITE, TRESPASSER].sort());

    const again = await topUp();
    expect(again).toEqual({ positions: { [ELSEWHERE]: 0, [ON_SITE]: 0, [TRESPASSER]: 0 }, boundaries: 0, zones: 0 });

    // Ten minutes on, one more position each, continued rather than restarted.
    const later = await topUp(new Date(NOW.getTime() + STEP_MS));
    expect(Object.values(later.positions)).toEqual([2, 2, 2]);
  });

  it('never replaces a boundary somebody drew', async () => {
    const drawn = { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
    await owner.query(`UPDATE plant SET boundary = $1::jsonb WHERE id = $2`, [JSON.stringify(drawn), siteId]);
    await topUp();
    const [{ boundary }] = await owner.query(`SELECT boundary FROM plant WHERE id = $1`, [siteId]);
    expect(boundary).toEqual(drawn);
  });

  it('two position top-ups at once both settle, and each position is written once', async () => {
    const results = await Promise.allSettled([topUp(), topUp()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [{ dupes }] = await owner.query(
      `SELECT count(*)::int AS dupes FROM (SELECT 1 FROM telemetry_reading GROUP BY imei, signal, source_timestamp HAVING count(*) > 1) d`,
    );
    expect(dupes).toBe(0);
    expect(await owner.query(`SELECT count(*)::int AS n FROM geofence_zone`)).toEqual([{ n: 2 }]);
  });

  it('the fleet map: who is where, inside or out, and who is breaking a rule — with every shape to draw', async () => {
    await topUp();
    const status = await fleet.status(acme, {}, NOW);
    const byId = new Map(status.machines.map((x) => [x.externalId, x]));

    expect(status.summary).toEqual({ machines: 5, live: 3, stale: 0, noPosition: 2, violating: 1 });
    expect(byId.get(ON_SITE)).toMatchObject({ positionStatus: 'live', violating: false, site: { code: 'VIZAG' } });
    expect(byId.get(TRESPASSER)).toMatchObject({ positionStatus: 'live', violating: true });
    const trespass = byId.get(TRESPASSER)!.zones.find((z) => z.key.startsWith('zone:'))!;
    expect(trespass).toMatchObject({ inside: true, violation: true });
    // Fitted but silent, and no logger at all: no position, and not counted as fine.
    expect(byId.get('ASLEEP')).toMatchObject({ position: null, positionStatus: 'none', zones: [], violating: false });
    expect(byId.get('NO-LOGGER')).toMatchObject({ position: null, positionStatus: 'none', site: null });

    // Every zone a listed machine has, with its shape, so a map draws in one call.
    expect(status.zones.map((z) => [z.source, z.code]).sort()).toEqual([
      ['site-boundary', 'site:PUNE'], ['site-boundary', 'site:VIZAG'],
      ['zone', 'DEMO-NOGO-PUNE'], ['zone', 'DEMO-NOGO-VIZAG'],
    ]);
    expect(status.zones.every((z) => z.shape && typeof z.shape.type === 'string')).toBe(true);
  });

  it('a position older than 15 minutes is shown as stale, not live', async () => {
    await topUp();
    const status = await fleet.status(acme, {}, new Date(NOW.getTime() + 20 * 60_000));
    expect(status.machines.find((x) => x.externalId === ON_SITE)).toMatchObject({ positionStatus: 'stale' });
  });

  it('one site\'s machines only, and a person narrowed to one site neither sees nor draws the other', async () => {
    await topUp();
    expect((await fleet.status(acme, { plantId: otherSiteId }, NOW)).machines.map((x) => x.externalId)).toEqual([ELSEWHERE]);
    const vizagOnly: RequestScope = { ...acme, plantIds: [siteId], equipmentIds: [ON_SITE, TRESPASSER] };
    const status = await fleet.status(vizagOnly, {}, NOW);
    expect(status.machines.map((x) => x.externalId).sort()).toEqual([ON_SITE, TRESPASSER].sort());
    expect(JSON.stringify(status)).not.toMatch(/PUNE|Pune/);
  });

  it('end to end: simulated GPS, the shift pass\'s visits and events, and hours in the no-go area', async () => {
    // A morning of positions, ten minutes apart, then the shift pass over them.
    for (let t = istAt(9, 30).getTime(); t <= istAt(11, 30).getTime(); t += STEP_MS) {
      for (const id of [ON_SITE, TRESPASSER]) await reported(id, new Date(t - 60_000));
      await topUp(new Date(t));
    }
    const readings = await owner.query(
      `SELECT imei, signal, value, source_timestamp AS "sourceTimestamp" FROM telemetry_reading
        WHERE imei = $1 AND signal IN ('latitude', 'longitude')`,
      [imeiOf(TRESPASSER)],
    );
    await tracker.trackWindow({
      tenantId: 'acme', sourceSystem: 'ta-2.0', externalId: TRESPASSER, start: istAt(9), end: istAt(12),
      readings: readings.map((r: { imei: string; signal: string; value: number; sourceTimestamp: Date }) =>
        ({ ...r, sourceTimestamp: new Date(r.sourceTimestamp).toISOString() })),
    });

    const [visit] = await owner.query(
      `SELECT entered_at AS "in", left_at AS "out" FROM geofence_visit WHERE zone_code = 'DEMO-NOGO-VIZAG'`,
    );
    expect([visit.in.getTime(), visit.out.getTime()]).toEqual([istAt(10).getTime(), istAt(11).getTime()]);
    const types = (await owner.query(
      `SELECT event_type AS t, payload->>'violation' AS v FROM domain_event WHERE payload->>'zoneCode' = 'DEMO-NOGO-VIZAG'`,
    )).map((e: { t: string; v: string }) => [e.t, e.v]).sort();
    expect(types).toEqual([['geofence.entered.v1', 'true'], ['geofence.left.v1', 'false']]);

    const hours = await tracker.timeInZone(acme, { from: istAt(0), to: istAt(23), timezone: 'Asia/Kolkata' }, istAt(12));
    expect(hours.find((h) => h.zoneCode === 'DEMO-NOGO-VIZAG')).toMatchObject({ day: '2026-10-29', hours: 1 });
  });

  it('over HTTP: an operator reads the fleet map; a bad site id is refused; anonymous is not let in', async () => {
    await topUp();
    const auth = `Bearer ${await app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000d1', client_id: 'acme', roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
    )}`;
    const res = await request(app.getHttpServer()).get('/api/v1/geofences/fleet-status').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.machines).toHaveLength(5);
    expect(res.body.zones.length).toBeGreaterThan(0);
    expect((await request(app.getHttpServer()).get('/api/v1/geofences/fleet-status?siteId=nope').set('Authorization', auth)).status).toBe(400);
    expect((await request(app.getHttpServer()).get('/api/v1/geofences/fleet-status')).status).toBe(401);
  });
});
