import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { writeFuelFigures } from '../src/catalog/services/class-fuel-figures';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';

/**
 * Fuel test report, follow-up of 4 Nov 2026: every machine's expected litres (D55) said
 * "can't be worked out yet", and nothing in Master Admin showed which class figures were
 * missing or where to load them. The class page now reads them from this route.
 *
 * `blockedBy` is D55's own answer, so these hold it to what a machine on the same version
 * would be told: never a second reading of the same figures.
 */
describeDb('a class version\'s fuel figures, and what D55 still needs from them', () => {
  let owner: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });

    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => { await owner.query(`TRUNCATE TABLE "equipment_class_profile" CASCADE`); });

  const bearer = (role: 'master-admin' | 'catalog-author' | 'platform-support') =>
    mintPlatformToken({ role, subject: `${role}@things-alive.io` }, { secret: SECRET, issuer: ISSUER }).token;
  const figures = (slug: string, version: number, role: Parameters<typeof bearer>[0] = 'master-admin') =>
    request(app.getHttpServer())
      .get(`/api/v1/catalog/authoring/equipment-classes/${slug}/fuel-figures?version=${version}`)
      .set('Authorization', `Bearer ${bearer(role)}`);

  // Through the same writer the catalog import uses: the columns are not on the entity.
  const klass = (version: number, row: Partial<EquipmentClassProfile>, fuel: Record<string, unknown> = {}) =>
    owner.transaction(async (m) => {
      const saved = await m.getRepository(EquipmentClassProfile).save({
        slug: 'hydraulic-excavator', version, name: 'Hydraulic Excavator', status: 'published', publishedAt: new Date(),
        expectedSignals: [], ...row,
      } as Partial<EquipmentClassProfile>);
      if (Object.keys(fuel).length) await writeFuelFigures(m, saved.id, fuel);
      return saved;
    });

  it('nothing loaded: every figure null, and the three D55 waits on named at once', async () => {
    await klass(3, {});
    const res = await figures('hydraulic-excavator', 3);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      classSlug: 'hydraulic-excavator', classVersion: 3, className: 'Hydraulic Excavator', workingRateFrom: null,
      blockedBy: ['working_rate_not_set', 'working_share_not_set', 'idle_fuel_per_hour_not_set'],
      figures: { ratedPowerKw: null, workingLoadPct: null, bsfcGPerKwh: null, bsfcSource: null, idleFuelPerHour: null, workingShare: null },
    });
  });

  it('a datasheet BSFC with its power, load, idle burn and share: nothing missing, rate from BSFC', async () => {
    await klass(3, {}, {
      ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1 performance data',
      idleFuelPerHour: 2.1, workingShare: 0.7,
    });
    const res = await figures('hydraulic-excavator', 3);
    expect(res.body).toMatchObject({ blockedBy: [], workingRateFrom: 'bsfc', figures: { bsfcSource: 'Cat C7.1 performance data' } });
  });

  it('a class nominal in L/h and a share of 1 need nothing else: rate from the nominal, no idle burn asked for', async () => {
    await klass(3, { nominalFuelPerHour: 15, nominalFuelUnit: 'L/h' } as Partial<EquipmentClassProfile>, { workingShare: 1 });
    const res = await figures('hydraulic-excavator', 3);
    expect(res.body).toMatchObject({ blockedBy: [], workingRateFrom: 'nominal', figures: { nominalFuelPerHour: 15 } });
  });

  it('a nominal in another unit is named, not converted', async () => {
    await klass(3, { nominalFuelPerHour: 4, nominalFuelUnit: 'gal/h' } as Partial<EquipmentClassProfile>, { workingShare: 1 });
    expect((await figures('hydraulic-excavator', 3)).body.blockedBy).toEqual(['nominal_unit_not_litres']);
  });

  it('per version: figures on v3 say nothing about v2', async () => {
    await klass(2, {});
    await klass(3, {}, { ratedPowerKw: 121, workingLoadPct: 60, bsfcGPerKwh: 215, bsfcSource: 'Cat C7.1', idleFuelPerHour: 2.1, workingShare: 0.7 });
    expect((await figures('hydraulic-excavator', 2)).body.blockedBy).toHaveLength(3);
    expect((await figures('hydraulic-excavator', 3)).body.blockedBy).toEqual([]);
  });

  it('a class version that does not exist is 404', async () => {
    await klass(3, {});
    expect((await figures('hydraulic-excavator', 9)).status).toBe(404);
    expect((await figures('no-such-class', 3)).status).toBe(404);
  });

  it('a catalog author reads it; a caller without catalog.write is refused with 403', async () => {
    await klass(3, {});
    expect((await figures('hydraulic-excavator', 3, 'catalog-author')).status).toBe(200);
    expect((await figures('hydraulic-excavator', 3, 'platform-support')).status).toBe(403);
  });
});
