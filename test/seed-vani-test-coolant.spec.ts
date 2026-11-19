import { DataSource } from 'typeorm';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { VANI_TEST_TENANT, chooseVaniStory, seedVaniTest } from '../src/database/seeds/seed-vani-test';
import { createTestDataSource, describeDb } from './db';

/**
 * `seed:vani-test` against a library that cannot tell the bearing story (decided
 * 2026-11-19): Development's published `diesel-generator` v1 declares one signal,
 * `coolant_temp_c`, with a critical limit of 105 °C. This spec builds exactly that class
 * and seeds it. The full library's bearing story stays `seed-vani-test.spec.ts`.
 *
 * The refusal is the case that matters most on a shared database: a class the seed
 * cannot tell any story about is refused before anything is written, because the seed
 * commits in steps and is never undone.
 */
describe('seed:vani-test: which story the library allows', () => {
  const now = new Date('2026-11-19T10:00:00Z');

  it('tells the bearing story when vibration is declared, and coolant when only coolant is', () => {
    expect(chooseVaniStory(new Set(['vibration_velocity', 'coolant_temp']), {}, now).name).toBe('bearing');
    const coolant = chooseVaniStory(new Set(['coolant_temp_c']), { coolant_temp_c: { max: 105 } }, now);
    expect(coolant.name).toBe('coolant');
    expect(coolant.rule).toMatchObject({ signal: 'coolant_temp_c', max: 105 });
    // Only what the class declares is reported: no rpm or load on a coolant-only class.
    expect(coolant.readings.map((r) => r.signal)).toEqual(['coolant_temp_c']);
    // The engine's rule needs most of the last ten readings past the limit.
    expect(coolant.readings[0].values.slice(-10).every((v) => v > 105)).toBe(true);
  });

  it('uses the class\'s own coolant limit', () => {
    expect(chooseVaniStory(new Set(['coolant_temp']), { coolant_temp: { max: 98 } }, now).rule.max).toBe(98);
  });

  it('refuses a class it can tell no story about', () => {
    expect(() => chooseVaniStory(new Set(['fuel_level']), {}, now)).toThrow(/no alert story.*Nothing was written/);
  });
});

describeDb('seed:vani-test on a coolant-only library', () => {
  let ds: DataSource;
  const env = { SEED_VANI_TEST_ENABLED: 'true', DB_HOST: 'localhost' };
  const now = new Date('2026-11-19T10:00:00Z');

  const publishClass = (expectedSignals: unknown[], defaultThresholds: object) =>
    ds.getRepository(EquipmentClassProfile).save({
      slug: 'diesel-generator', version: 1, status: 'published' as any, name: 'Diesel generator',
      description: null, category: 'power', expectedSignals, failureModes: [], defaultThresholds, publishedAt: now,
    } as any);

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); });

  it('refuses before writing anything when the class gives it no story', async () => {
    await publishClass([{ signal: 'fuel_level', unit: '%', required: true }], {});
    await expect(seedVaniTest(ds, { now, env })).rejects.toThrow(/no alert story/);
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM tenant WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(n).toBe(0);
    await ds.query(`DELETE FROM equipment_class_profile`);
  });

  it('seeds the coolant story, raises the alert, and queues one call that says it plainly', async () => {
    await publishClass(
      [{ signal: 'coolant_temp_c', unit: 'degC', required: true, description: 'Coolant temperature' }],
      { coolant_temp_c: { max: 105, unit: 'degC', severity: 'critical' } },
    );
    const result = await seedVaniTest(ds, { now, env });
    expect(result).toMatchObject({ created: true, story: 'coolant', alertsRaised: 1, callsQueued: 1 });

    const [call] = await ds.query(`SELECT request FROM vani_call WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
    expect(call.request.trigger).toMatchObject({ severity: 'critical', title: 'Coolant temperature on Diesel Generator DG-01 is running hot' });
    expect(call.request.context.recommended_action).toBe('Check the coolant level and clear the radiator fins before the next shift.');
    // Said as words: "coolant temperature", "degrees Celsius", never the signal key.
    expect(call.request.context.summary).toMatch(/^Coolant temperature on Diesel Generator DG-01 has been above 105 degrees Celsius/);
    expect(call.request.context.summary).not.toMatch(/_/);
  });
});
