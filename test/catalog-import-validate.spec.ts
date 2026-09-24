import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { Workbook } from 'exceljs';
import { createApp } from '../src/main';
import { mintPlatformToken } from '../src/platform/platform-token';
import { EquipmentClassFormula } from '../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile, ExpectedSignal } from '../src/catalog/entities/equipment-class-profile.entity';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const SECRET = 'test-secret-for-signing';
const ISSUER = 'things-alive-platform-test';
const CLASS_SLUG = 'diesel-generator';

/**
 * Semantic validation, the dry-run diff, and the endpoints (task QIMP2).
 *
 * Every negative case starts from the real generated template, exactly like
 * catalog-import-parse.spec.ts, so a rejection is proven against a workbook that is
 * otherwise valid — one deliberate change away — rather than something already wrong
 * in five other ways.
 */
describeDb('catalog import: validation, dry-run diff, endpoints', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let diff: CatalogImportDiffService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    diff = new CatalogImportDiffService(ds);
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor"
       RESTART IDENTITY CASCADE`,
    );
    // The template's own sensor_capability example names this sensor. Seeded by
    // default so the plain template validates cleanly; the "resolves to zero/several"
    // tests use a different sensor_name rather than un-seeding this one, so they do
    // not disturb every other test's baseline.
    await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({ sensorName: 'Coolant Temp Probe' }));
  });

  const seedClass = async (slug: string, expectedSignals: ExpectedSignal[]): Promise<void> => {
    await ds.getRepository(EquipmentClassProfile).save(
      ds.getRepository(EquipmentClassProfile).create({
        slug, version: 1, name: slug, status: 'published', expectedSignals,
      }),
    );
  };

  const workbookBuffer = async (mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const base = await templates.build(new Date('2026-09-22T00:00:00.000Z'));
    if (!mutate) return base;
    const wb = new Workbook();
    // Same exceljs/@types-node Buffer mismatch worked around in the QIMP1 spec.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(base as any);
    mutate(wb);
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };

  // ExcelJS does not preserve worksheet.columns key metadata across a save/reload
  // round trip (see catalog-import-parse.spec.ts) — rows are appended by the
  // template's own known column order instead.
  const addRow = (wb: Workbook, sheetName: string, values: Record<string, unknown>) => {
    const schema = ALL_SHEETS.find((s) => s.sheet === sheetName)!;
    wb.getWorksheet(sheetName)!.addRow(schema.columns.map((c) => values[c.name] ?? ''));
  };

  const parseAndValidate = async (buffer: Buffer, filename = 'wb.xlsx') => {
    const parsed = await parser.parse(buffer, filename, 'deepak');
    await validator.validate(parsed.id);
    return parsed;
  };

  const rowsFor = (batchId: string, sheet: string) =>
    ds.getRepository(CatalogImportRow).find({ where: { batchId, sheet }, order: { rowNumber: 'ASC' } });

  describe('semantic validation', () => {
    it('the plain template validates cleanly: every row ends up "valid"', async () => {
      const { id } = await parseAndValidate(await workbookBuffer());
      const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: id } });
      expect(rows.every((r) => r.status === 'valid')).toBe(true);
    });

    it('refuses a class_slug that is neither in this batch nor in the catalog', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: 'ghost-machine', signal: 'x', unit: 'unit', required: 'TRUE',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = await rowsFor(id, 'signal').then((rs) => rs.filter((r) => r.rowNumber === 3));
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/class "ghost-machine".*not defined.*not exist in the catalog/);
    });

    it('resolves a class_slug that already exists in the catalog, not just in this batch', async () => {
      await seedClass('concrete-pump', [{ signal: 'boom_angle_deg', unit: 'deg', required: true }]);
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: 'concrete-pump', signal: 'boom_angle_deg', unit: 'deg', required: 'TRUE',
          criticality: 'required', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('valid');
    });

    // There is no "sensor_requirement role never declared as an expected_signal" case
    // to test any more: `signal` is the one column that both is the role and names
    // expected_signals, so a row cannot disagree with itself (template v3).

    it('a blank criticality is valid: the class declares the signal without requiring it fitted', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'oil_pressure_kpa', unit: 'kPa', required: 'FALSE', criticality: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('valid');
    });

    it('refuses an unrecognised criticality', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_a', unit: 'unitX', required: 'TRUE',
          criticality: 'urgent-ish', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/"urgent-ish" is not a valid criticality/);
    });

    it('refuses an unrecognised enables value, naming it', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_b', unit: 'unitX', required: 'TRUE',
          criticality: 'required', min_count: 1, enables: 'data_quality,telepathy',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/"telepathy".*not a recognised enables value/);
    });

    it('accepts two rows for the same signal with different component_scope, agreeing on the shared fields', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_c', unit: 'unitX', required: 'TRUE',
          component_scope: 'left', criticality: 'required', min_count: 1,
        });
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_c', unit: 'unitX', required: 'TRUE',
          component_scope: 'right', criticality: 'recommended', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = (await rowsFor(id, 'signal')).filter((r) => [3, 4].includes(r.rowNumber));
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.status).toBe('valid');
    });

    it('rejects rows sharing a signal that disagree on a signal-level field, naming both row numbers', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_d', unit: 'unitX', required: 'TRUE',
          component_scope: 'left', criticality: 'required', min_count: 1,
        });
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_d', unit: 'unitY', required: 'TRUE',
          component_scope: 'right', criticality: 'required', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = (await rowsFor(id, 'signal')).filter((r) => [3, 4].includes(r.rowNumber));
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/must agree.*\(rows 3, 4\)/);
      }
    });

    it('refuses an unrecognised formula kind', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'formula', {
          class_slug: CLASS_SLUG, formula_key: 'weird_formula', kind: 'clairvoyance',
          expression: 'x', inputs: 'coolant_temp_c', output_unit: 'L', basis: '', references: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/"clairvoyance" is not a valid kind/);
    });

    it('refuses a blank unit where the sheet has a unit column', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_e', unit: '', required: 'TRUE',
          criticality: 'required', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/"unit" is required/);
    });

    it('refuses a formula input that names neither a declared signal nor another formula_key', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'formula', {
          class_slug: CLASS_SLUG, formula_key: 'bad_formula', kind: 'empirical',
          expression: 'x', inputs: 'totally_unknown_thing', output_unit: 'L', basis: '', references: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/input "totally_unknown_thing" names neither/);
    });

    it('resolves a formula input against a formula_key the catalog already has for the class', async () => {
      // The formula row's FK needs (class_slug, class_version) to exist first.
      await seedClass(CLASS_SLUG, [{ signal: 'coolant_temp_c', unit: 'degC', required: true }]);
      await ds.getRepository(EquipmentClassFormula).save(ds.getRepository(EquipmentClassFormula).create({
        classSlug: CLASS_SLUG, classVersion: 1, formulaKey: 'baseline_load', kind: 'empirical',
        expression: 'rated_kw * 0.8', inputs: [], status: 'proposed',
      }));
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'formula', {
          class_slug: CLASS_SLUG, formula_key: 'derived_metric', kind: 'empirical',
          expression: 'baseline_load * 2', inputs: 'baseline_load', output_unit: 'L', basis: '', references: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'formula')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('valid');
    });

    it('refuses a sensor_capability name that resolves to zero sensors', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Nonexistent Probe', signal: 'coolant_temp_c',
          parameter_key: 'temperature', canonical_unit: 'degC',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'sensor_capability')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/resolves to 0 sensor\(s\)/);
    });

    it('refuses a sensor_capability name that resolves to several sensors', async () => {
      await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({ sensorName: 'Ambiguous Probe' }));
      await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({ sensorName: 'Ambiguous Probe' }));
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Ambiguous Probe', signal: 'coolant_temp_c',
          parameter_key: 'temperature', canonical_unit: 'degC',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'sensor_capability')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/resolves to 2 sensor\(s\)/);
    });

    it('rejects duplicates within the batch, naming both row numbers', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'equipment_class', {
          slug: CLASS_SLUG, name: 'Diesel Generator (duplicate)', description: '', category: '',
          service_interval_hours: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = (await rowsFor(id, 'equipment_class')).filter((r) => [2, 3].includes(r.rowNumber));
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/duplicate within this batch \(rows 2, 3\)/);
      }
    });

    it('rejects a duplicate (class_slug, signal, component_scope) on the signal sheet', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_f', unit: 'unitX', required: 'TRUE', component_scope: 'x1',
        });
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'new_signal_f', unit: 'unitX', required: 'TRUE', component_scope: 'x1',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = (await rowsFor(id, 'signal')).filter((r) => [3, 4].includes(r.rowNumber));
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/duplicate within this batch \(rows 3, 4\)/);
      }
    });

    it('a signal row with both min and max blank is valid: it declares no threshold', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'vibration_mm_s', unit: 'mm/s', required: 'TRUE', min: '', max: '',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('valid');
    });

    it('refuses a severity with neither a minimum nor a maximum', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'vibration_mm_s', unit: 'mm/s', required: 'TRUE',
          min: '', max: '', severity: 'high',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const [row] = (await rowsFor(id, 'signal')).filter((r) => r.rowNumber === 3);
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/"severity" is set but neither "min" nor "max" is/);
    });

    it('rejects equal bounds and inverted bounds alike', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'fuel_level_pct', unit: '%', required: 'TRUE', min: 50, max: 50,
        });
        addRow(wb, 'signal', {
          class_slug: CLASS_SLUG, signal: 'engine_load_pct', unit: '%', required: 'TRUE', min: 90, max: 10,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = (await rowsFor(id, 'signal')).filter((r) => [3, 4].includes(r.rowNumber));
      for (const r of rows) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/min \(\d+\) must be below max \(\d+\)/);
      }
    });
  });

  describe('the dry-run diff', () => {
    it('classifies a brand new class as "create"', async () => {
      const { id } = await parseAndValidate(await workbookBuffer());
      const result = await diff.buildDiff(id);
      const entry = result.classes.find((c) => c.slug === CLASS_SLUG)!;
      expect(entry.action).toBe('create');
      // sensor_capability is never nested under a class: it has no class_slug of its
      // own (a sensor is device-catalog reference data, not tied to one class), so it
      // is reported separately, in sensorCapabilities below.
      expect(entry.countsBySheet).toEqual({
        equipment_class: 1, signal: 1, failure_mode: 1, formula: 1,
      });
      expect(result.sensorCapabilities).toEqual({ valid: 1, invalid: 0 });
    });

    it('classifies content for an existing class as "new_version"', async () => {
      await seedClass(CLASS_SLUG, [
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
      ]);
      const { id } = await parseAndValidate(await workbookBuffer());
      const result = await diff.buildDiff(id);
      const entry = result.classes.find((c) => c.slug === CLASS_SLUG)!;
      expect(entry.action).toBe('new_version');
    });

    it('classifies an existing class as "unchanged" when nothing valid actually targets it', async () => {
      await seedClass('concrete-pump', [{ signal: 'boom_angle_deg', unit: 'deg', required: true }]);
      const buffer = await workbookBuffer((wb) => {
        // References concrete-pump, but with an unrecognised criticality — the only
        // row naming it is invalid, so nothing valid actually reaches it.
        addRow(wb, 'signal', {
          class_slug: 'concrete-pump', signal: 'not_a_real_role', unit: 'deg', required: 'TRUE',
          criticality: 'not-a-real-criticality', min_count: 1,
        });
      });
      const { id } = await parseAndValidate(buffer);
      const result = await diff.buildDiff(id);
      const entry = result.classes.find((c) => c.slug === 'concrete-pump')!;
      expect(entry.action).toBe('unchanged');
      expect(entry.countsBySheet).toEqual({});
    });

    it('lists every rejected row with its sheet, row number and reason', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: 'ghost-machine', signal: 'x', unit: 'unit', required: 'TRUE',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const result = await diff.buildDiff(id);
      const rejected = result.rejectedRows.find((r) => r.sheet === 'signal' && r.rowNumber === 3);
      expect(rejected?.reason).toMatch(/ghost-machine/);
    });

    it('says explicitly whether applying would skip anything', async () => {
      const clean = await parseAndValidate(await workbookBuffer());
      expect((await diff.buildDiff(clean.id)).partialApplyNote).toMatch(/nothing would be skipped/i);

      const dirty = await parseAndValidate(await workbookBuffer((wb) => {
        addRow(wb, 'signal', {
          class_slug: 'ghost-machine', signal: 'x', unit: 'unit', required: 'TRUE',
        });
      }));
      expect((await diff.buildDiff(dirty.id)).partialApplyNote).toMatch(/1 row\(s\) are invalid.*would be skipped/i);
    });

    it('writes nothing to the catalog tables', async () => {
      await seedClass('concrete-pump', [{ signal: 'boom_angle_deg', unit: 'deg', required: true }]);
      const before = await ds.getRepository(EquipmentClassProfile).count();
      const beforeFormulas = await ds.getRepository(EquipmentClassFormula).count();

      const { id } = await parseAndValidate(await workbookBuffer());
      await diff.buildDiff(id);
      await diff.list();

      expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(before);
      expect(await ds.getRepository(EquipmentClassFormula).count()).toBe(beforeFormulas);
      const [{ count: reqCount }] = await owner.query(
        `SELECT count(*)::int FROM "equipment_class_sensor_requirement"`,
      );
      expect(reqCount).toBe(0);
      const [{ count: capCount }] = await owner.query(`SELECT count(*)::int FROM "sensor_role_capability"`);
      expect(capCount).toBe(0);
    });
  });

  describe('the endpoints', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = SECRET;
      process.env.AUTH_JWT_ISSUER = ISSUER;
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      app = await createApp({ database: true });
      await app.init();
    }, 30_000);

    afterAll(async () => { await app?.close(); });

    const bearer = (role: 'master-admin' | 'platform-support') =>
      mintPlatformToken({ role, subject: 'deepak@things-alive.io' }, { secret: SECRET, issuer: ISSUER }).token;

    it('uploads, parses and validates a workbook in one call, and reuses catalog.write — not a new capability', async () => {
      const buffer = await workbookBuffer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform/catalog/imports')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .attach('file', buffer, 'template.xlsx');

      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();

      const rows = await ds.getRepository(CatalogImportRow).find({ where: { batchId: res.body.id } });
      expect(rows.every((r) => r.status === 'valid')).toBe(true);
    });

    it('refuses a caller without catalog.write', async () => {
      const buffer = await workbookBuffer();
      const upload = await request(app.getHttpServer())
        .post('/api/v1/platform/catalog/imports')
        .set('Authorization', `Bearer ${bearer('platform-support')}`)
        .attach('file', buffer, 'template.xlsx');
      expect(upload.status).toBe(403);

      const template = await request(app.getHttpServer())
        .get('/api/v1/platform/catalog/template')
        .set('Authorization', `Bearer ${bearer('platform-support')}`);
      expect(template.status).toBe(403);
    });

    it('downloads the generated template', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/catalog/template')
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/spreadsheetml/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
    });

    it('lists recent batches and serves the diff for one of them', async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/v1/platform/catalog/imports')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .attach('file', await workbookBuffer(), 'template.xlsx');
      const batchId = upload.body.id;

      const recent = await request(app.getHttpServer())
        .get('/api/v1/platform/catalog/imports')
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(recent.status).toBe(200);
      expect(recent.body.some((b: { id: string }) => b.id === batchId)).toBe(true);

      const diffRes = await request(app.getHttpServer())
        .get(`/api/v1/platform/catalog/imports/${batchId}`)
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(diffRes.status).toBe(200);
      expect(diffRes.body.classes.find((c: { slug: string }) => c.slug === CLASS_SLUG)?.action).toBe('create');
    });

    it('attempts the dry-run diff over HTTP and leaves the catalog tables untouched', async () => {
      const before = await ds.getRepository(EquipmentClassProfile).count();

      const upload = await request(app.getHttpServer())
        .post('/api/v1/platform/catalog/imports')
        .set('Authorization', `Bearer ${bearer('master-admin')}`)
        .attach('file', await workbookBuffer(), 'template.xlsx');

      const diffRes = await request(app.getHttpServer())
        .get(`/api/v1/platform/catalog/imports/${upload.body.id}`)
        .set('Authorization', `Bearer ${bearer('master-admin')}`);
      expect(diffRes.status).toBe(200);

      expect(await ds.getRepository(EquipmentClassProfile).count()).toBe(before);
      const [{ count }] = await owner.query(`SELECT count(*)::int FROM "equipment_class_sensor_requirement"`);
      expect(count).toBe(0);
    });
  });
});
