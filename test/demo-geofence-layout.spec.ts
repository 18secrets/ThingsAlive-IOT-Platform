import { DataSource } from 'typeorm';
import {
  demoMovement, demoNoGoZone, demoPosition, demoSiteBoundary, demoSiteCentre, ensureDemoGeofences, legacyDemoBoundary,
} from '../src/database/seeds/demo-geofence';
import { haversineM, insideZone, LngLat } from '../src/geofence/geometry';
import { createTestDataSource, describeDb } from './db';

const IST = 5.5 * 3_600_000;
const istAt = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 29, hour, minute) - IST).getTime();
const SITES = ['PUNE-01', 'PUNE-02', '0483', '0556', '0616', '0624'];
const TYPES = {
  tipper: 'rock-tipper-truck ROCK BODY TIPPER - 35 MT',
  excavator: 'hydraulic-excavator HYDRAULIC EXCAVATOR PC 2000',
  generator: 'prime-diesel-generator Diesel Generator Set 500 KVA',
  crane: 'heavy-crawler-crane Liebherr 70T',
};

/** The demo's real-ground layout (task QGEO2): the first version's squares read as fake on a map. */
describe('QGEO2: demo sites on real ground', () => {
  it('every chosen site keeps each kind of machine inside its parcel and out of its no-go area, all day', () => {
    for (const code of SITES) {
      const centre = demoSiteCentre(code);
      const parcel = demoSiteBoundary(centre);
      const noGo = demoNoGoZone(centre);
      for (const [kind, type] of Object.entries(TYPES)) {
        for (let n = 1; n <= 25; n += 1) {
          const id = `${code}-${kind}-${n}`;
          const scripted = demoMovement(id, kind === 'tipper' ? 'mobile' : kind === 'generator' ? 'stationary' : 'working');
          for (let h = 0; h < 24; h += 1) {
            if (scripted === 'enters_no_go' && h === 10) continue;
            if (scripted === 'leaves_site' && (h === 13 || h === 14)) continue;
            const p = demoPosition(id, centre, istAt(h, 7), type);
            expect([code, kind, h, insideZone(parcel, p) && !insideZone(noGo, p)]).toEqual([code, kind, h, true]);
          }
        }
      }
    }
  });

  it('machines whose ids differ in one digit get spots of their own, not one on top of another', () => {
    const centre = demoSiteCentre('PUNE-01');
    const spots = Array.from({ length: 10 }, (_, i) => demoPosition(`EX-${String(i + 1).padStart(2, '0')}`, centre, istAt(9), TYPES.generator));
    const gaps = spots.flatMap((a, i) => spots.slice(i + 1).map((b) => haversineM(a, b)));
    expect(gaps.filter((g) => g < 15)).toHaveLength(0);
  });

  it('a site is an irregular parcel, and the expressway package a long corridor', () => {
    const ring = demoSiteBoundary(demoSiteCentre('0556')).coordinates[0];
    expect(new Set(ring.map((p) => p.join())).size).toBe(9);
    const corridor = demoSiteBoundary(demoSiteCentre('PUNE-01')).coordinates[0] as LngLat[];
    const lengths = corridor.flatMap((a) => corridor.map((b) => haversineM(a, b)));
    expect(Math.max(...lengths)).toBeGreaterThan(1800); // ~2 km long
    const centre = demoSiteCentre('PUNE-01');
    const nearest = Math.min(...corridor.map((p) => haversineM(centre, p)));
    expect(nearest).toBeLessThan(450); // and a few hundred metres wide
  });
});

describeDb('QGEO2: moving the first version\'s demo fences onto real ground', () => {
  let owner: DataSource;
  let plantId: string;
  const legacyNoGo = { type: 'Circle', center: [73.9, 18.5], radiusM: 150 };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
  }, 30_000);
  afterAll(async () => { await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "geofence_zone", "plant" CASCADE`);
    [{ id: plantId }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, boundary) VALUES ('acme', '0483', 'Plant 0483', $1::jsonb) RETURNING id`,
      [JSON.stringify(legacyDemoBoundary('0483'))],
    );
    await owner.query(
      `INSERT INTO geofence_zone (tenant_id, code, name, kind, shape, applies_to, plant_id, created_by, updated_by)
       VALUES ('acme', 'DEMO-NOGO-0483', 'No-go area (demo), 0483', 'restricted', $1::jsonb, 'plant', $2, 'seed-demo', 'seed-demo')`,
      [JSON.stringify(legacyNoGo), plantId],
    );
  });

  const state = async () => ({
    boundary: (await owner.query(`SELECT boundary FROM plant WHERE id = $1`, [plantId]))[0].boundary,
    noGo: (await owner.query(`SELECT shape FROM geofence_zone WHERE code = 'DEMO-NOGO-0483'`))[0].shape,
  });

  it('replaces the seed\'s own square and no-go circle once, and the second run changes nothing', async () => {
    expect(await ensureDemoGeofences(owner, 'acme', [{ id: plantId, code: '0483' }])).toEqual({ boundaries: 1, zones: 1 });
    const centre = demoSiteCentre('0483');
    expect(await state()).toEqual({ boundary: demoSiteBoundary(centre), noGo: demoNoGoZone(centre) });
    expect(await ensureDemoGeofences(owner, 'acme', [{ id: plantId, code: '0483' }])).toEqual({ boundaries: 0, zones: 0 });
  });

  it('leaves a no-go zone somebody has edited, even one the seed first drew', async () => {
    await owner.query(`UPDATE geofence_zone SET updated_by = 'u-site-manager' WHERE code = 'DEMO-NOGO-0483'`);
    await ensureDemoGeofences(owner, 'acme', [{ id: plantId, code: '0483' }]);
    expect((await state()).noGo).toEqual(legacyNoGo);
  });
});
