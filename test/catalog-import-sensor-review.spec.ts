import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { CatalogImportBatch as CatalogImportBatchEntity } from '../src/catalog-import/entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../src/catalog-import/entities/catalog-import-row.entity';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { CatalogImportDiffService } from '../src/catalog-import/services/catalog-import-diff.service';
import { CatalogImportSensorReviewService } from '../src/catalog-import/services/catalog-import-sensor-review.service';
import { CatalogImportValidatorService } from '../src/catalog-import/services/catalog-import-validator.service';
import { CatalogTemplateService } from '../src/catalog-import/services/catalog-template.service';
import { WorkbookParserService } from '../src/catalog-import/services/workbook-parser.service';
import { ALL_SHEETS } from '../src/catalog-import/template-schema';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The sensor catalog: propose from the workbook, create on approval (task QIMP5).
 *
 * The diagnostic that led here found the deployed resolver keyed on a display name,
 * one message for two different failures, and no distinction between an identical
 * repeat (harmless — one physical sensor registered once per class that uses it)
 * and a genuine conflict. Every test below proves the split, not just that the
 * feature exists.
 */
describeDb('catalog import: the sensor catalog', () => {
  let ds: DataSource;
  let owner: DataSource;
  let parser: WorkbookParserService;
  let validator: CatalogImportValidatorService;
  let diff: CatalogImportDiffService;
  let applier: CatalogImportApplyService;
  let review: CatalogImportSensorReviewService;
  let templates: CatalogTemplateService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    parser = new WorkbookParserService(ds);
    validator = new CatalogImportValidatorService(ds);
    diff = new CatalogImportDiffService(ds);
    applier = new CatalogImportApplyService(ds);
    review = new CatalogImportSensorReviewService(ds, diff, validator);
    templates = new CatalogTemplateService();
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch",
        "equipment_class_formula", "equipment_class_sensor_requirement",
        "sensor_role_capability", "equipment_class_profile", "sensor", "sensor_category"
       RESTART IDENTITY CASCADE`,
    );
    // The template's own sensor_capability example names this sensor and this is
    // its real slug — seeded so the plain template validates cleanly, exactly like
    // catalog-import-validate.spec.ts's baseline.
    await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
      sensorName: 'Coolant Temp Probe', slug: 'coolant-temp-probe',
    }));
  });

  const workbookBuffer = async (mutate?: (wb: Workbook) => void): Promise<Buffer> => {
    const base = await templates.build(new Date('2026-09-22T00:00:00.000Z'));
    if (!mutate) return base;
    const wb = new Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(base as any);
    mutate(wb);
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  };

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

  // ---------------------------------------------------------------- §1: split codes

  describe('split reject codes', () => {
    it('a sensor name matching nothing in the catalog is sensor_not_found, and says it can be proposed', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Ghost Sensor', signal: 'ghost_signal', parameter_key: 'x', canonical_unit: 'unit',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const row = rows.find((r) => r.payload.sensor_name === 'Ghost Sensor')!;
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/sensor_not_found/);
      expect(row.message).toMatch(/can be proposed/);
    });

    it('a sensor name matching two or more sensors is sensor_ambiguous, naming every candidate', async () => {
      await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
        sensorName: 'Ambiguous Probe', slug: 'ambiguous-probe-a',
      }));
      await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
        sensorName: 'Ambiguous Probe', slug: 'ambiguous-probe-b',
      }));
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Ambiguous Probe', signal: 'x', parameter_key: 'x', canonical_unit: 'unit',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const row = rows.find((r) => r.payload.sensor_name === 'Ambiguous Probe')!;
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/sensor_ambiguous/);
      expect(row.message).toMatch(/ambiguous-probe-a/);
      expect(row.message).toMatch(/ambiguous-probe-b/);
    });
  });

  // -------------------------------------------------------- §2: resolve by a slug

  describe('resolve by a stable key', () => {
    it('resolves by sensor_slug, exact, no fallback', async () => {
      // parameter_key set apart from the template's own default sensor_capability
      // row (also "Coolant Temp Probe", parameter_key "temperature") — otherwise
      // the two group together under one capability and disagree on `category`.
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'whatever text', sensor_slug: 'coolant-temp-probe',
          signal: 'coolant_temp_c', parameter_key: 'temperature_2', canonical_unit: 'degC',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const row = rows.find((r) => r.payload.sensor_slug === 'coolant-temp-probe')!;
      expect(row.status).toBe('valid');
    });

    it('a slug that does not exist is sensor_not_found even when the row\'s name would have matched', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Coolant Temp Probe', sensor_slug: 'no-such-slug',
          signal: 'coolant_temp_c', parameter_key: 'temperature', canonical_unit: 'degC',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const row = rows.find((r) => r.payload.sensor_slug === 'no-such-slug')!;
      expect(row.status).toBe('invalid');
      expect(row.message).toMatch(/sensor_not_found/);
    });

    it('resolves by sensor_name, case- and whitespace-insensitively, when no slug is given', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: '  coolant temp probe  ',
          signal: 'coolant_temp_c', parameter_key: 'temperature_2', canonical_unit: 'degC',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const result = await diff.buildDiff(id);
      const rows = await rowsFor(id, 'sensor_capability');
      const row = rows.find((r) => String(r.payload.sensor_name).trim().toLowerCase() === 'coolant temp probe')!;
      expect(row.status).toBe('valid');
      // The diff exists independently of this row's own status — its presence here
      // just confirms buildDiff ran without touching the catalog.
      expect(result.batchId).toBe(id);
    });
  });

  // -------------------------------------------------- §3: identical vs conflicting

  describe('identical global rows are a no-op; conflicting rows are refused', () => {
    it('four identical rows collapse to one capability, deduplicated_rows: 4, nothing rejected', async () => {
      await ds.getRepository(Sensor).save(ds.getRepository(Sensor).create({
        sensorName: 'Repeated Sensor', slug: 'repeated-sensor',
      }));
      const buffer = await workbookBuffer((wb) => {
        for (let i = 0; i < 4; i += 1) {
          addRow(wb, 'sensor_capability', {
            sensor_name: 'Repeated Sensor', signal: 'repeated_signal',
            parameter_key: 'value', canonical_unit: 'unit',
          });
        }
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const repeated = rows.filter((r) => r.payload.sensor_name === 'Repeated Sensor');
      expect(repeated).toHaveLength(4);
      for (const r of repeated) expect(r.status).toBe('valid');

      const result = await diff.buildDiff(id);
      const group = result.deduplicatedRows.find((g) => g.rowNumbers.length === 4);
      expect(group).toBeDefined();
    });

    it('two rows differing only in canonical_unit are conflicting_capability, naming both', async () => {
      const buffer = await workbookBuffer((wb) => {
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Split Unit Sensor', signal: 'split_signal',
          parameter_key: 'value', canonical_unit: 'degC',
        });
        addRow(wb, 'sensor_capability', {
          sensor_name: 'Split Unit Sensor', signal: 'split_signal',
          parameter_key: 'value', canonical_unit: 'degF',
        });
      });
      const { id } = await parseAndValidate(buffer);
      const rows = await rowsFor(id, 'sensor_capability');
      const split = rows.filter((r) => r.payload.sensor_name === 'Split Unit Sensor');
      expect(split).toHaveLength(2);
      for (const r of split) {
        expect(r.status).toBe('invalid');
        expect(r.message).toMatch(/conflicting_capability/);
        expect(r.message).toMatch(/canonical_unit/);
      }
    });
  });

  // ------------------------------------------------------------- §7: numbered tests

  describe('propose, approve, dismiss', () => {
    const proposalWorkbook = async () => workbookBuffer((wb) => {
      addRow(wb, 'equipment_class', {
        slug: 'excavator-x', name: 'Excavator X', description: '', category: '', service_interval_hours: '',
      });
      addRow(wb, 'signal', {
        class_slug: 'excavator-x', signal: 'boom_angle_deg', unit: 'deg', required: 'TRUE',
      });
      addRow(wb, 'signal', {
        class_slug: 'excavator-x', signal: 'bucket_angle_deg', unit: 'deg', required: 'TRUE',
      });
      addRow(wb, 'signal', {
        class_slug: 'excavator-x', signal: 'arm_angle_deg', unit: 'deg', required: 'TRUE',
      });
      addRow(wb, 'sensor_capability', {
        sensor_name: 'Boom Angle Sensor', category: 'Excavator Sensors',
        signal: 'boom_angle_deg', parameter_key: 'boom_angle', canonical_unit: 'deg',
      });
      addRow(wb, 'sensor_capability', {
        sensor_name: 'Bucket Angle Sensor', category: 'Excavator Sensors',
        signal: 'bucket_angle_deg', parameter_key: 'bucket_angle', canonical_unit: 'deg',
      });
      addRow(wb, 'sensor_capability', {
        sensor_name: 'Arm Angle Sensor', category: 'Excavator Sensors',
        signal: 'arm_angle_deg', parameter_key: 'arm_angle', canonical_unit: 'deg',
      });
    });

    it('1. a workbook naming three absent sensors produces three proposedSensors, each naming its class', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const result = await diff.buildDiff(id);
      expect(result.proposedSensors).toHaveLength(3);
      for (const p of result.proposedSensors) {
        expect(p.usedByClasses).toEqual(['excavator-x']);
      }
    });

    it('2. one sensor used by six classes is one proposal with six usedByClasses', async () => {
      const buffer = await workbookBuffer((wb) => {
        const slugs = ['class-a', 'class-b', 'class-c', 'class-d', 'class-e', 'class-f'];
        for (const slug of slugs) {
          addRow(wb, 'equipment_class', { slug, name: slug, description: '', category: '', service_interval_hours: '' });
          addRow(wb, 'signal', { class_slug: slug, signal: 'shared_signal', unit: 'unit', required: 'TRUE' });
        }
        for (const slug of slugs) {
          addRow(wb, 'sensor_capability', {
            sensor_name: 'Shared Sensor', signal: 'shared_signal', parameter_key: 'value', canonical_unit: 'unit',
          });
        }
      });
      const { id } = await parseAndValidate(buffer);
      const result = await diff.buildDiff(id);
      const proposal = result.proposedSensors.find((p) => p.name === 'Shared Sensor')!;
      expect(proposal).toBeDefined();
      expect(proposal.usedByClasses).toHaveLength(6);
      // Six identical rows for one sensor+parameter also collapse to one dedup group.
      const dedupGroup = result.deduplicatedRows.find((g) => g.rowNumbers.length === 6);
      expect(dedupGroup).toBeDefined();
    });

    it('3. approving two of three creates those two as sensor rows; the third stays outstanding', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      const [first, second] = before.proposedSensors;

      await review.review(id, { approveCategories: [{ slug: 'excavator-sensors' }], approve: [{ slug: first.slug }, { slug: second.slug }] }, 'deepak');

      const createdFirst = await ds.getRepository(Sensor).findOne({ where: { slug: first.slug } });
      const createdSecond = await ds.getRepository(Sensor).findOne({ where: { slug: second.slug } });
      expect(createdFirst).not.toBeNull();
      expect(createdSecond).not.toBeNull();

      const after = await diff.buildDiff(id);
      expect(after.proposedSensors.map((p) => p.slug)).not.toContain(first.slug);
      expect(after.proposedSensors.map((p) => p.slug)).not.toContain(second.slug);
      expect(after.proposedSensors).toHaveLength(1);
    });

    it('4. apply with an outstanding proposal is refused, naming the affected class', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      await expect(applier.apply(id, 'deepak')).rejects.toThrow(/excavator-x/);
    });

    it('5. dismissing the third then applying succeeds directly — a dismissal is a decision, not a block', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      const slugs = before.proposedSensors.map((p) => p.slug);

      await review.review(id, {
        approveCategories: [{ slug: 'excavator-sensors' }],
        approve: [{ slug: slugs[0] }, { slug: slugs[1] }],
        dismiss: [{ slug: slugs[2] }],
      }, 'deepak');

      // The dismissed sensor's capability row stays invalid and is skipped — a
      // class's expected signals come from the `signal` sheet alone, so the class
      // itself still applies with all three of its signals. 3 created: the two
      // approved sensors plus the template's own default Coolant Temp Probe row.
      const summary = await applier.apply(id, 'deepak');
      expect(summary.classes['excavator-x']).toBeDefined();
      expect(summary.sensorCapabilities.created).toBe(3);
      expect(summary.sensorCapabilities.skipped).toBe(1);
    });

    it('6. approving the same slug twice leaves one decision row, not two', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      const slug = before.proposedSensors[0].slug;

      await review.review(id, { approveCategories: [{ slug: 'excavator-sensors' }], approve: [{ slug }] }, 'deepak');
      await review.review(id, { approve: [{ slug }] }, 'deepak');

      const batch = await ds.getRepository(CatalogImportBatchEntity).findOneOrFail({ where: { id } });
      const decisions = batch.sensorDecisions.filter((d) => d.slug === slug);
      expect(decisions).toHaveLength(1);
    });

    it('7. approving a slug not among this batch\'s proposals is refused', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      await expect(review.review(id, { approve: [{ slug: 'not-a-real-proposal' }] }, 'deepak'))
        .rejects.toThrow(/not a proposed sensor/);
    });

    it('8. after approval the recomputed diff resolves those rows, with no re-upload', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      // Coolant Temp Probe (seeded) resolves; the three excavator sensors do not yet.
      expect(before.sensorCapabilities).toEqual({ valid: 1, invalid: 3 });

      const slugs = before.proposedSensors.map((p) => p.slug);
      const after = await review.review(id, {
        approveCategories: [{ slug: 'excavator-sensors' }],
        approve: slugs.map((slug) => ({ slug })),
      }, 'deepak');

      expect(after.sensorCapabilities).toEqual({ valid: 4, invalid: 0 });
      expect(after.proposedSensors).toHaveLength(0);
    });

    it('9. two concurrent approvals of the same batch produce one set of sensors, no error', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      const request = {
        approveCategories: [{ slug: 'excavator-sensors' }],
        approve: before.proposedSensors.map((p) => ({ slug: p.slug })),
      };

      const results = await Promise.allSettled([
        review.review(id, request, 'deepak-a'),
        review.review(id, request, 'deepak-b'),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      for (const p of before.proposedSensors) {
        const rows = await ds.getRepository(Sensor).find({ where: { slug: p.slug } });
        expect(rows).toHaveLength(1);
      }
    });

    it('10. a row naming a category the catalog lacks produces a proposedCategories entry listing its sensors', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const result = await diff.buildDiff(id);
      expect(result.proposedCategories).toHaveLength(1);
      expect(result.proposedCategories[0].name).toBe('Excavator Sensors');
      expect(result.proposedCategories[0].proposedBySensors).toHaveLength(3);
    });

    it('11. approving a sensor whose category is neither existing nor in approveCategories is refused, no orphan created', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);
      const slug = before.proposedSensors[0].slug;

      await expect(review.review(id, { approve: [{ slug }] }, 'deepak')).rejects.toThrow(/category/);
      expect(await ds.getRepository(Sensor).findOne({ where: { slug } })).toBeNull();
    });

    it('12. one call approving a category and three sensors in it creates all four in one transaction', async () => {
      const { id } = await parseAndValidate(await proposalWorkbook());
      const before = await diff.buildDiff(id);

      await review.review(id, {
        approveCategories: [{ slug: 'excavator-sensors' }],
        approve: before.proposedSensors.map((p) => ({ slug: p.slug })),
      }, 'deepak');

      const category = await ds.getRepository(SensorCategory).findOne({ where: { name: 'Excavator Sensors' } });
      expect(category).not.toBeNull();
      for (const p of before.proposedSensors) {
        const sensor = await ds.getRepository(Sensor).findOne({ where: { slug: p.slug } });
        expect(sensor?.categoryId).toBe(category!.id);
      }
    });
  });

  describe('the plain template, on a fresh catalog', () => {
    it('is refused on apply — its own example sensor is the proposal, not a synthetic one', async () => {
      // A truly empty catalog, not just this file's usual baseline seed: the
      // first-use experience this pins is a brand-new database, before anyone has
      // approved anything at all.
      await owner.query(`DELETE FROM "sensor"`);

      const buffer = await workbookBuffer(); // no mutate — the exact bytes `npm run catalog:template` produces
      const { id } = await parseAndValidate(buffer);

      const result = await diff.buildDiff(id);
      expect(result.proposedSensors).toHaveLength(1);
      expect(result.proposedSensors[0].name).toBe('Coolant Temp Probe');

      await expect(applier.apply(id, 'deepak')).rejects.toThrow(/proposed sensor/);
    });
  });
});
