import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { REQUIRES_KEY } from '../src/auth/guards/capability.guard';
import { can } from '../src/auth/capabilities';
import { RequestScope } from '../src/auth/types/request-scope';
import { DeviceCatalogController } from '../src/device-catalog/device-catalog.controller';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'IndustryTypes1760100000000';

/**
 * Industry types, read by tool mappings (task QINDUSTRY). The list was React state and
 * the mapping's industry was free text, so "Cement", "cement" and "Cemnt" were three
 * industries. Every rule here is attempted, as `ta_app`, and refused by the database.
 */
describe('who may touch industry types', () => {
  const routes = ['listIndustryTypes', 'createIndustryType', 'updateIndustryType', 'deleteIndustryType',
    'unmatchedIndustries', 'rematchIndustries'] as const;

  it('every route needs device-catalog.write, which no tenant role holds', () => {
    for (const route of routes) {
      expect(Reflect.getMetadata(REQUIRES_KEY, DeviceCatalogController.prototype[route])).toBe('device-catalog.write');
    }
    for (const role of ['super admin', 'admin', 'operational', 'support', 'viewer']) {
      const tenant: RequestScope = { tenantId: 'acme', userId: 'u', roles: [role], isPlatformRole: false };
      expect({ role, allowed: can(tenant, 'device-catalog.write') }).toEqual({ role, allowed: false });
    }
  });
});

describeDb('industry types', () => {
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;
  const pre: string[] = [];

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    // Seeded before it runs (CLAUDE.md): the state the migration changes.
    await undoMigrationNamed(owner, MIGRATION);
    for (const text of ['Cement & Building Materials', 'cbm', 'Cemnt', null, '']) {
      const [row] = await owner.query(
        `INSERT INTO tool_mapping (tool_name, industry_type) VALUES ($1, $2) RETURNING id`, [`tool ${text}`, text],
      );
      pre.push(row.id);
    }
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await owner.runMigrations({ transaction: 'all' });
    expect(log).toHaveBeenCalledWith('IndustryTypes: 0 tool mapping(s) matched an industry type, 3 left unmatched.');
    log.mockRestore();
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping));
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const insertType = (name: string, code: string, status = 'active') => ds.query(
    `INSERT INTO industry_type (name, code, status) VALUES ($1, $2, $3) RETURNING id`, [name, code, status],
  );

  describe('the database refuses, as ta_app', () => {
    beforeAll(async () => { await insertType('Mining & Aggregates', 'MIN'); });

    it.each([
      ['a duplicate name in another case', 'mining & AGGREGATES', 'MNX', /uq_industry_type_name/],
      ['a duplicate code', 'Mining Two', 'MIN', /uq_industry_type_code/],
      ['a blank name', '   ', 'BLK', /ck_industry_type_name/],
      ['a lowercase code', 'Lower', 'low', /ck_industry_type_code/],
      ['a one-letter code', 'Short', 'S', /ck_industry_type_code/],
      ['a code with punctuation', 'Punct', 'A-B', /ck_industry_type_code/],
    ])('%s', async (_label, name, code, refusal) => {
      await expect(insertType(name, code)).rejects.toThrow(refusal);
    });

    it('the service says the same in sentences, and stores codes uppercase', async () => {
      await expect(catalog.createIndustryType({ name: 'MINING & aggregates', code: 'mx' }, 'u')).rejects.toThrow(/already called/);
      const made = await catalog.createIndustryType({ name: 'Marine', code: 'mar' }, 'u');
      expect(made.code).toBe('MAR');
    });
  });

  describe('tool mappings point at one', () => {
    it('deleting a type a mapping points at is refused by the foreign key, naming the count', async () => {
      const type = await catalog.createIndustryType({ name: 'Power & Energy', code: 'PWR' }, 'u');
      await catalog.createToolMapping({ toolName: 'Genset logger', industryTypeId: type.id });
      await expect(ds.query(`DELETE FROM industry_type WHERE id = $1`, [type.id])).rejects.toThrow(/fk_tool_mapping_industry_type/);
      await expect(catalog.deleteIndustryType(type.id)).rejects.toThrow(/used by 1 tool mapping/);
    });

    it('deactivating is allowed, the mapping keeps it, and a new mapping cannot choose it', async () => {
      const type = await catalog.createIndustryType({ name: 'Transport & Fleet', code: 'TRN' }, 'u');
      const mapping = await catalog.createToolMapping({ toolName: 'Truck logger', industryTypeId: type.id });
      await catalog.updateIndustryType(type.id, { status: 'inactive' }, 'u');
      expect((await catalog.getToolMapping(mapping.id)).industryType).toBe('Transport & Fleet');
      // An unrelated edit does not trip over the now-inactive type it already has.
      await catalog.updateToolMapping(mapping.id, { protocol: 'MQTT' });
      await expect(catalog.createToolMapping({ toolName: 'Van logger', industryTypeId: type.id }))
        .rejects.toThrow(/must name an active industry type/);
      expect((await catalog.listIndustryTypes('active')).map((t) => t.code)).not.toContain('TRN');
    });

    it('free text is accepted only when it names one active type exactly; otherwise a 400 naming them', async () => {
      const ok = await catalog.createToolMapping({ toolName: 'By code', industryType: 'pwr' });
      expect(ok.industryType).toBe('Power & Energy');
      await expect(catalog.createToolMapping({ toolName: 'Typo', industryType: 'Powr' }))
        .rejects.toThrow(/not an active industry type.*Power & Energy \(PWR\)/);
    });

    it('nothing writes the legacy text again, by any door', async () => {
      await expect(ds.query(`UPDATE tool_mapping SET industry_type_legacy = 'x' WHERE id = $1`, [pre[2]]))
        .rejects.toThrow(/tool_mapping_legacy_industry_frozen/);
      await expect(ds.query(`INSERT INTO tool_mapping (tool_name, industry_type_legacy) VALUES ('t', 'Cement')`))
        .rejects.toThrow(/tool_mapping_legacy_industry_frozen/);
    });
  });

  describe('the text from before', () => {
    it('is listed with counts while unmatched, and no type was invented from it', async () => {
      const unmatched = await catalog.unmatchedIndustries();
      expect(unmatched).toEqual(expect.arrayContaining([
        { text: 'Cement & Building Materials', mappings: 1 }, { text: 'cbm', mappings: 1 }, { text: 'Cemnt', mappings: 1 },
      ]));
      expect((await catalog.listIndustryTypes()).map((t) => t.name)).not.toContain('Cemnt');
    });

    it('re-matches once the real type exists: name and code match, the typo stays listed, empty text untouched', async () => {
      await catalog.createIndustryType({ name: 'Cement & Building Materials', code: 'CBM' }, 'u');
      expect(await catalog.rematchIndustries()).toEqual({ matched: 2, unmatched: 1 });
      const rows: { id: string; industry_type_id: string | null }[] = await owner.query(
        `SELECT id, industry_type_id FROM tool_mapping WHERE id = ANY($1::uuid[])`, [pre],
      );
      const typeOf = (i: number) => rows.find((r) => r.id === pre[i])!.industry_type_id;
      expect([typeOf(0), typeOf(1)].every(Boolean)).toBe(true);
      expect([typeOf(2), typeOf(3), typeOf(4)]).toEqual([null, null, null]);
      expect(await catalog.unmatchedIndustries()).toEqual([{ text: 'Cemnt', mappings: 1 }]);
    });
  });

  it(`down path (${MIGRATION}): the free text comes back, and a type-only mapping gets its type's name`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    try {
      const rows: { tool_name: string; industry_type: string | null }[] = await owner.query(
        `SELECT tool_name, industry_type FROM tool_mapping ORDER BY tool_name`,
      );
      const by = new Map(rows.map((r) => [r.tool_name, r.industry_type]));
      expect(by.get('tool Cemnt')).toBe('Cemnt');
      expect(by.get('tool cbm')).toBe('cbm');
      expect(by.get('Genset logger')).toBe('Power & Energy');
      expect(await owner.query(`SELECT to_regclass('industry_type') AS t`)).toEqual([{ t: null }]);
    } finally {
      await owner.runMigrations({ transaction: 'all' });
    }
  }, 60_000);
});
