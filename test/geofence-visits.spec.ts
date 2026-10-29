import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { GeofenceTracker, TrackWindow } from '../src/geofence/geofence-tracker.service';
import { GeofenceService } from '../src/geofence/geofence.service';
import { LngLat, ZoneShape } from '../src/geofence/geometry';
import { planVisits, WindowReading, windowPositions } from '../src/geofence/visit-plan';
import { createApp } from '../src/main';
import { ShiftRunner } from '../src/shift/services/shift-runner.service';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'GeofenceVisits1762900000000';
const SECRET = 'test-secret-geofence-visits';
const ISSUER = 'things-alive-geofence-visits-test';

const YARD: ZoneShape = { type: 'Polygon', coordinates: [[[83.2, 17.7], [83.21, 17.7], [83.21, 17.71], [83.2, 17.71], [83.2, 17.7]]] };
const PIT: ZoneShape = { type: 'Circle', center: [83.205, 17.705], radiusM: 200 };
const OUT: LngLat = [83.22, 17.705]; // beyond the yard
const YARD_ONLY: LngLat = [83.202, 17.708]; // in the yard, ~450 m from the pit
const IN_PIT: LngLat = [83.205, 17.705];

const DAY = Date.parse('2026-10-29T00:00:00Z');
const at = (minute: number) => new Date(DAY + minute * 60_000);
/** One GPS fix: a latitude and a longitude reading from the same logger at the same moment. */
const fix = (minute: number, [lng, lat]: LngLat, imei = 'L1'): WindowReading[] => [
  { imei, signal: 'latitude', value: lat, sourceTimestamp: at(minute).toISOString() },
  { imei, signal: 'longitude', value: lng, sourceTimestamp: at(minute).toISOString() },
];
const path = (...fixes: [number, LngLat][]) => fixes.flatMap(([m, p]) => fix(m, p));

/** Geofence visits (task QGEO2, stage 2). */
describe('QGEO2: planning visits from a window', () => {
  const window = { start: at(0), end: at(480) };
  const zones = [{ key: 'zone:pit', shape: PIT }];

  it('pairs a logger\'s own latitude and longitude, and keeps to the window: after the start, up to the end', () => {
    const readings = [
      ...fix(0, IN_PIT), ...fix(10, IN_PIT), ...fix(480, OUT),
      // Two loggers at one moment: two positions, never one made from both.
      ...fix(20, IN_PIT, 'L1'), ...fix(20, OUT, 'L2'),
      { imei: 'L1', signal: 'engine_coolant_temperature', value: 90, sourceTimestamp: at(30).toISOString() },
    ];
    expect(windowPositions(readings, window).map((p) => [p.at.getTime(), p.lng])).toEqual([
      [at(10).getTime(), 83.205], [at(20).getTime(), 83.205], [at(20).getTime(), 83.22], [at(480).getTime(), 83.22],
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  });

  it('opens a visit at the reading that put it in and closes it at the one that took it out', () => {
    const positions = windowPositions(path([10, OUT], [20, IN_PIT], [30, IN_PIT], [40, YARD_ONLY]), window);
    expect(planVisits(zones, new Set(), positions)).toEqual([
      { key: 'zone:pit', enteredAt: at(20), entry: IN_PIT, leftAt: at(40), exit: YARD_ONLY },
    ]);
  });

  it('carries a visit in from the window before, and leaves one still inside open', () => {
    const positions = windowPositions(path([10, OUT], [20, IN_PIT]), window);
    expect(planVisits(zones, new Set(['zone:pit']), positions)).toEqual([
      { key: 'zone:pit', enteredAt: null, entry: null, leftAt: at(10), exit: OUT },
      { key: 'zone:pit', enteredAt: at(20), entry: IN_PIT, leftAt: null, exit: null },
    ]);
  });
});

describeDb('QGEO2: geofence visits', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let tracker: GeofenceTracker;
  let zones: GeofenceService;
  let plantId: string;
  let pitId: string;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const shift = (start: number, end: number, readings: WindowReading[]): TrackWindow => ({
    tenantId: 'acme', sourceSystem: 'ta-2.0', externalId: 'DT-1', start: at(start), end: at(end), readings,
  });
  const visits = async () => (await owner.query(
    `SELECT zone_code AS zone, entered_at AS "in", left_at AS "out", left_reason AS reason
       FROM geofence_visit ORDER BY entered_at, zone_code`,
  )).map((v: { zone: string; in: Date; out: Date | null; reason: string | null }) => [
    v.zone, (v.in.getTime() - DAY) / 60_000, v.out === null ? null : (v.out.getTime() - DAY) / 60_000, v.reason,
  ]);
  const events = async () => (await owner.query(
    `SELECT event_type AS type, payload->>'zoneCode' AS zone, payload->>'violation' AS violation
       FROM domain_event WHERE event_type LIKE 'geofence.%' ORDER BY occurred_at, created_at`,
  )).map((e: { type: string; zone: string; violation: string | null }) => [e.type, e.zone, e.violation]);

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
    tracker = app.get(GeofenceTracker);
    zones = app.get(GeofenceService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "geofence_visit", "geofence_zone", "domain_event", "equipment_profile", "plant" CASCADE`);
    [{ id: plantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, status, boundary) VALUES ('acme', 'VIZAG', 'Vizag yard', 'active', $1::jsonb) RETURNING id`,
      [JSON.stringify(YARD)],
    );
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
         VALUES ('acme', 'ta-2.0', 'DT-1', 'Dumper 1', 'client', 'active', 'basic', '{}'::jsonb, $1)`,
      [plantId],
    );
    ({ id: pitId } = await zones.create(acme, { code: 'PIT', name: 'Blast pit', kind: 'restricted', shape: PIT, appliesTo: 'account' }));
  });

  it('a shift through the yard and the pit: two visits, and an event for each crossing, saying which broke a rule', async () => {
    const result = await tracker.trackWindow(shift(0, 480, path([10, YARD_ONLY], [20, IN_PIT], [30, YARD_ONLY], [40, OUT])));
    expect(result).toEqual({ positions: 4, entered: 2, left: 2, revised: 0, withdrawn: 0 });
    expect(await visits()).toEqual([['site:VIZAG', 10, 40, 'exited'], ['PIT', 20, 30, 'exited']]);
    expect(await events()).toEqual([
      ['geofence.entered.v1', 'site:VIZAG', 'false'],
      ['geofence.entered.v1', 'PIT', 'true'],
      ['geofence.left.v1', 'PIT', 'false'],
      ['geofence.left.v1', 'site:VIZAG', 'true'],
    ]);
  });

  it('the same window again writes nothing and says nothing', async () => {
    const w = shift(0, 480, path([10, YARD_ONLY], [20, IN_PIT], [30, OUT]));
    await tracker.trackWindow(w);
    const before = await events();
    expect(await tracker.trackWindow(w)).toEqual({ positions: 3, entered: 0, left: 0, revised: 0, withdrawn: 0 });
    expect(await events()).toEqual(before);
  });

  it('two passes over one window at once both settle, and the visits and events happen once', async () => {
    const w = shift(0, 480, path([10, YARD_ONLY], [20, IN_PIT], [30, OUT]));
    const results = await Promise.allSettled([tracker.trackWindow(w), tracker.trackWindow(w)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await visits()).toEqual([['site:VIZAG', 10, 30, 'exited'], ['PIT', 20, 30, 'exited']]);
    expect((await events()).filter(([t]) => t === 'geofence.entered.v1')).toHaveLength(2);
  });

  it('a visit open at the end of one shift is the same visit the next shift closes', async () => {
    await tracker.trackWindow(shift(0, 480, path([470, IN_PIT])));
    expect(await visits()).toEqual([['PIT', 470, null, null], ['site:VIZAG', 470, null, null]]);
    await tracker.trackWindow(shift(480, 960, path([500, YARD_ONLY], [510, OUT])));
    expect(await visits()).toEqual([['PIT', 470, 500, 'exited'], ['site:VIZAG', 470, 510, 'exited']]);
    expect((await events()).map(([t]) => t)).toEqual([
      'geofence.entered.v1', 'geofence.entered.v1', 'geofence.left.v1', 'geofence.left.v1',
    ]);
  });

  it('a late reading that shows an earlier exit closes the visit there, as a revision of nothing — it was open', async () => {
    await tracker.trackWindow(shift(0, 480, path([10, IN_PIT])));
    // The rewound shift, now with the reading that arrived late.
    await tracker.trackWindow(shift(0, 480, path([10, IN_PIT], [15, YARD_ONLY])));
    expect(await visits()).toEqual([['PIT', 10, 15, 'exited'], ['site:VIZAG', 10, null, null]]);
    expect((await events()).at(-1)).toEqual(['geofence.left.v1', 'PIT', 'false']);
  });

  it('a late reading that moves an entry earlier withdraws the visit that was and publishes the one that is', async () => {
    await tracker.trackWindow(shift(0, 480, path([10, YARD_ONLY], [30, IN_PIT], [40, YARD_ONLY])));
    await tracker.trackWindow(shift(0, 480, path([10, YARD_ONLY], [20, IN_PIT], [30, IN_PIT], [40, YARD_ONLY])));
    expect((await visits()).filter(([z]) => z === 'PIT')).toEqual([['PIT', 20, 40, 'exited']]);
    // Which events, not their order: one transaction's rows share a created_at.
    const pit = (await events()).filter(([, z]) => z === 'PIT').map(([t]) => t).sort();
    expect(pit).toEqual([
      'geofence.entered.v1', 'geofence.entered.v1', 'geofence.left.v1', 'geofence.left.v1', 'geofence.visit.withdrawn.v1',
    ]);
    const [withdrawn] = await owner.query(
      `SELECT payload->>'enteredAt' AS "enteredAt" FROM domain_event WHERE event_type = 'geofence.visit.withdrawn.v1'`,
    );
    expect(withdrawn.enteredAt).toBe(at(30).toISOString());
  });

  it('re-running an earlier shift keeps the exit a later shift found — that time is not the earlier shift\'s to decide', async () => {
    await tracker.trackWindow(shift(0, 480, path([470, IN_PIT])));
    await tracker.trackWindow(shift(480, 960, path([500, OUT])));
    await tracker.trackWindow(shift(0, 480, path([470, IN_PIT])));
    expect(await visits()).toEqual([['PIT', 470, 500, 'exited'], ['site:VIZAG', 470, 500, 'exited']]);
  });

  it('a zone switched off closes the visit inside it at the next shift\'s start, without inventing an exit', async () => {
    await tracker.trackWindow(shift(0, 480, path([470, IN_PIT])));
    await zones.update(acme, pitId, { enabled: false });
    await tracker.trackWindow(shift(480, 960, path([500, IN_PIT])));
    expect((await visits()).filter(([z]) => z === 'PIT')).toEqual([['PIT', 470, 480, 'zone_removed']]);
  });

  describe('the database holds', () => {
    const insertVisit = (cols: Record<string, unknown> = {}) => withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO geofence_visit (tenant_id, source_system, external_id, zone_key, zone_source, zone_code, zone_name, zone_kind,
                                   entered_at, entry_lng, entry_lat, left_at, exit_lng, exit_lat, left_reason)
         VALUES ('acme', 'ta-2.0', 'DT-1', $1, 'zone', 'PIT', 'Blast pit', 'restricted', $2, 83.2, 17.7, $3, $4, $4, $5)`,
      [`zone:${pitId}`, cols.enteredAt ?? at(10), cols.leftAt ?? null, cols.exit ?? null, cols.reason ?? null],
    ));

    it('one open visit per machine and zone, whatever writes it', async () => {
      await insertVisit({ enteredAt: at(10) });
      await expect(insertVisit({ enteredAt: at(20) })).rejects.toThrow(/uq_geofence_visit_open/);
    });

    it('an exit has a time, a place and a reason together, and comes after the entry', async () => {
      await expect(insertVisit({ leftAt: at(20), reason: 'exited' })).rejects.toThrow(/ck_geofence_visit_left/);
      await expect(insertVisit({ leftAt: at(20), exit: 83.3 })).rejects.toThrow(/ck_geofence_visit_left/);
      await expect(insertVisit({ enteredAt: at(30), leftAt: at(20), exit: 83.3, reason: 'exited' }))
        .rejects.toThrow(/ck_geofence_visit_order/);
    });

    it('another account sees no visits, and deleting a zone keeps the record of who went there', async () => {
      await tracker.trackWindow(shift(0, 480, path([10, IN_PIT], [20, OUT])));
      expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT * FROM geofence_visit`))).toEqual([]);
      await zones.remove(acme, pitId);
      expect(await owner.query(`SELECT zone_code, zone_id FROM geofence_visit WHERE zone_code = 'PIT'`))
        .toEqual([{ zone_code: 'PIT', zone_id: null }]);
    });
  });

  it('the shift runner the app builds tracks geofences', () => {
    expect((app.get(ShiftRunner) as unknown as { geofences?: unknown }).geofences).toBeInstanceOf(GeofenceTracker);
  });

  describe('reading visits', () => {
    beforeEach(() => tracker.trackWindow(shift(0, 480, path([10, YARD_ONLY], [20, IN_PIT], [30, OUT]))));

    it('by machine and by zone, over HTTP, newest first; a bad date is refused', async () => {
      const auth = `Bearer ${await app.get(JwtService).signAsync(
        { sub: '00000000-0000-4000-8000-0000000000c1', client_id: 'acme', roles: ['operational'] }, { secret: SECRET, issuer: ISSUER },
      )}`;
      const byMachine = await request(app.getHttpServer()).get('/api/v1/equipment/ta-2.0/DT-1/geofence-visits').set('Authorization', auth);
      expect(byMachine.status).toBe(200);
      expect(byMachine.body.map((v: { zoneCode: string }) => v.zoneCode)).toEqual(['PIT', 'site:VIZAG']);
      const byZone = await request(app.getHttpServer()).get(`/api/v1/geofences/${pitId}/visits`).set('Authorization', auth);
      expect(byZone.body).toHaveLength(1);
      expect((await request(app.getHttpServer()).get('/api/v1/equipment/ta-2.0/DT-1/geofence-visits?from=yesterday')
        .set('Authorization', auth)).status).toBe(400);
    });

    it('a person who cannot see the site does not see visits to its boundary', async () => {
      const machineOnly: RequestScope = { ...acme, plantIds: [], equipmentIds: ['DT-1'] };
      expect((await tracker.visits(machineOnly, { sourceSystem: 'ta-2.0', externalId: 'DT-1' })).map((v) => v.zoneCode)).toEqual(['PIT']);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it(`${MIGRATION} down drops the visits table, and up brings it back`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT to_regclass('geofence_visit') AS t`)).toEqual([{ t: null }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('geofence_visit')::text AS t`)).toEqual([{ t: 'geofence_visit' }]);
  });
});
