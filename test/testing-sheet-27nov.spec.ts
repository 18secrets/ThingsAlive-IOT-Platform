import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { AssistantProposalService } from '../src/assistant/assistant-proposal.service';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { AssistantService } from '../src/assistant/assistant.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { CatalogImportApplyService } from '../src/catalog-import/services/catalog-import-apply.service';
import { EquipmentClassProfile } from '../src/catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../src/catalog/entities/equipment-class-sensor-requirement.entity';
import { RecommendationService } from '../src/catalog/services/recommendation.service';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { ClientScenario } from '../src/client-catalog/entities/client-scenario.entity';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../src/equipment/equipment-profile.entity';
import { createApp } from '../src/main';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { SignalBindingVersion } from '../src/signal-binding/entities/signal-binding-version.entity';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

type Input = { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] };

class ScriptedModel implements AssistantModel {
  readonly name = 'scripted';
  readonly seen: Input[] = [];
  constructor(private readonly step: (input: Input, n: number) => ModelReply) {}
  async generate(input: Input): Promise<ModelReply> {
    this.seen.push({ ...input, turns: [...input.turns] });
    return this.step(input, this.seen.length - 1);
  }
}

const say = (text: string): ModelReply => ({ text, calls: [], tokens: 10 });
const call = (name: string, args: Record<string, unknown>): ModelReply => ({ text: null, calls: [{ name, args }], tokens: 10 });

/**
 * The testing sheet of 27 Nov 2026: onboarding chat (TC_271, 274, 283), coverage of
 * component-scoped signals (TC_278), "No device fitted" (TC_295), a refused class row
 * in an import (TC_287), and what the New Class and Add Sensor forms write (TC_276,
 * TC_277). Each is asserted by doing the thing that went wrong and reading what the
 * database kept.
 */
describeDb('testing sheet 27 Nov', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const master: RequestScope = { tenantId: '', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-27nov';
    process.env.AUTH_JWT_ISSUER = 'things-alive-27nov-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  describe('onboarding chat', () => {
    let proposals: AssistantProposalService;

    beforeAll(() => { proposals = app.get(AssistantProposalService); });

    beforeEach(async () => {
      await owner.query(
        `TRUNCATE TABLE "assistant_proposal", "assistant_usage", "equipment_placement_event", "equipment_profile",
          "client_equipment_class", "plant" CASCADE`,
      );
      await owner.query(
        `INSERT INTO client_equipment_class (tenant_id, slug, name) VALUES
           ('acme', 'ashok-genset-180', 'Ashok Leyland genset 180'), ('acme', 'jcb-3dx', 'JCB 3DX backhoe')`,
      );
    });

    it('TC_271: a machine type the account was not given is refused, naming the ones it has', async () => {
      await expect(proposals.propose(acme, 'create_equipment', { code: 'CR-1', name: 'Crane 1', classSlug: 'tower-crane' }))
        .rejects.toThrow(/"tower-crane" is not available to this account.*Ashok Leyland genset 180 \(ashok-genset-180\), JCB 3DX backhoe \(jcb-3dx\)/);
      expect((await owner.query(`SELECT count(*)::int AS n FROM assistant_proposal`))[0].n).toBe(0);
    });

    it('TC_271: an archived type is not available either', async () => {
      await owner.query(`UPDATE client_equipment_class SET status = 'archived' WHERE slug = 'jcb-3dx'`);
      await expect(proposals.propose(acme, 'create_equipment', { code: 'BH-1', name: 'Backhoe 1', classSlug: 'jcb-3dx' }))
        .rejects.toThrow(/"jcb-3dx" is not available/);
    });

    it('TC_271: the card names the type by its name, not its slug', async () => {
      const p = await proposals.propose(acme, 'create_equipment', { code: 'GEN-4', name: 'Genset 4', classSlug: 'ashok-genset-180' });
      expect(p.summary).toBe('Add the machine "Genset 4" (code GEN-4), type Ashok Leyland genset 180, with no site yet.');
    });

    it('TC_271: a type withdrawn while the card waits fails at confirm, and no machine is made', async () => {
      const p = await proposals.propose(acme, 'create_equipment', { code: 'GEN-5', name: 'Genset 5', classSlug: 'ashok-genset-180' });
      await owner.query(`UPDATE client_equipment_class SET status = 'archived' WHERE slug = 'ashok-genset-180'`);
      const decided = await proposals.confirm(acme, p.id);
      expect(decided).toMatchObject({ status: 'failed' });
      expect(decided.error).toMatch(/not available/);
      expect((await owner.query(`SELECT count(*)::int AS n FROM equipment_profile WHERE external_id = 'GEN-5'`))[0].n).toBe(0);
    });

    it('TC_283: a name copied with its trailing comma is saved without it; a full stop stays', async () => {
      const genset = await proposals.propose(acme, 'create_equipment', { code: 'GEN-6', name: 'Genset 6, ' });
      expect(genset.payload).toMatchObject({ name: 'Genset 6' });
      await proposals.confirm(acme, genset.id);
      expect(await owner.query(`SELECT name FROM equipment_profile WHERE external_id = 'GEN-6'`)).toEqual([{ name: 'Genset 6' }]);

      const site = await proposals.propose(acme, 'create_site', { code: 'ACME', name: 'Acme Co.' });
      expect(site.payload).toMatchObject({ name: 'Acme Co.' });
    });

    it('TC_283: a name that is only punctuation is refused, not saved blank', async () => {
      await expect(proposals.propose(acme, 'create_equipment', { code: 'GEN-7', name: ' , ' }))
        .rejects.toThrow(/name is required/);
    });

    describe('TC_274: an answer saying it proposed something', () => {
      const assistant = (model: AssistantModel) => new AssistantService(ds, app.get(AssistantTools), model, 100_000);
      const ask = (text: string) => [{ role: 'user' as const, text }];

      beforeEach(async () => {
        await owner.query(`TRUNCATE TABLE "device_inventory_event", "device_inventory" CASCADE`);
        await owner.query(
          `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
             VALUES ('acme', 'ta-2.0', 'EX-1', 'Excavator 1', 'client', 'active', 'basic', '{}'::jsonb)`,
        );
        await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state) VALUES ('L1', 'acme', 'assigned')`);
      });

      it('with no proposal made, is sent back once, and the card exists in the answer the person reads', async () => {
        const model = new ScriptedModel((_, n) => [
          say('I have proposed fitting logger L1 to Excavator 1. Please confirm.'),
          call('propose_fit_logger', { imei: 'L1', equipmentCode: 'EX-1' }),
          say('I have proposed fitting logger L1 to Excavator 1. Please confirm.'),
        ][n]);
        const out = await assistant(model).onboarding(acme, ask('Fit logger L1 to Excavator 1'));

        expect(out.proposals).toHaveLength(1);
        expect(out.proposals[0]).toMatchObject({ kind: 'fit_logger', status: 'proposed' });
        expect(out.reply).toMatch(/proposed fitting/);
        // The note travels as the person's turn and never reaches the screen.
        const sentBack = model.seen[1].turns[model.seen[1].turns.length - 1];
        expect(sentBack).toMatchObject({ role: 'user' });
        expect((sentBack as { text: string }).text).toMatch(/no propose tool was called/);
        expect(model.seen[1].tools.map((t) => t.name)).toContain('propose_fit_logger');
      });

      it('a model that takes the claim back answers without one, and nothing is proposed', async () => {
        const model = new ScriptedModel((_, n) => [
          say('I have proposed fitting logger L1.'),
          say('Shall I propose fitting logger L1 to Excavator 1?'),
        ][n]);
        const out = await assistant(model).onboarding(acme, ask('Fit logger L1 to Excavator 1'));
        expect(out.reply).toBe('Shall I propose fitting logger L1 to Excavator 1?');
        expect(out.proposals).toEqual([]);
        expect(model.seen).toHaveLength(2);
      });

      it('is sent back only once: a second empty claim is the answer', async () => {
        const model = new ScriptedModel(() => say('I have proposed fitting logger L1.'));
        const out = await assistant(model).onboarding(acme, ask('Fit logger L1'));
        expect(model.seen).toHaveLength(2);
        expect(out.proposals).toEqual([]);
      });

      it('a claim backed by a proposal made in that answer goes straight through', async () => {
        const model = new ScriptedModel((_, n) => [
          call('propose_fit_logger', { imei: 'L1', equipmentCode: 'EX-1' }),
          say('I have proposed fitting logger L1 to Excavator 1.'),
        ][n]);
        const out = await assistant(model).onboarding(acme, ask('Fit logger L1 to Excavator 1'));
        expect(model.seen).toHaveLength(2);
        expect(out.proposals).toHaveLength(1);
      });

      it('the Ask AI chat is not sent back: it proposes nothing', async () => {
        const model = new ScriptedModel(() => say('I have proposed nothing; I only read.'));
        await assistant(model).chat(acme, ask('Can you fit a logger?'));
        expect(model.seen).toHaveLength(1);
      });
    });
  });

  describe('TC_278: coverage of a type that puts its signals on a component', () => {
    const CLASS = 'engine-genset';
    const AT = new Date('2026-11-27T12:00:00.000Z');

    beforeEach(async () => {
      for (const t of ['signal_binding_version', 'equipment_class_sensor_requirement', 'equipment_profile', 'equipment_class_profile']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
        slug: CLASS, version: 1, name: 'Engine genset', status: 'published',
        expectedSignals: [
          { signal: 'coolant_temp_c', unit: 'degC', required: true },
          { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
        ],
      }));
      const req = (measurementRole: string, componentScope: string) => owner.getRepository(EquipmentClassSensorRequirement).save(
        owner.getRepository(EquipmentClassSensorRequirement).create({
          classSlug: CLASS, classVersion: 1, measurementRole, componentScope, criticality: 'required', minCount: 1, enables: [],
        }),
      );
      await req('coolant_temp_c', 'engine');
      await req('oil_pressure_kpa', 'left');
      await req('oil_pressure_kpa', 'right');
      await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'EG-1',
        equipmentClassSlug: CLASS, classVersion: 1, name: 'EG-1',
      }));
      // As Signal Bindings saves them: no component.
      const bind = (role: string, imei: string, canonicalUnit: string) => owner.getRepository(SignalBindingVersion).save(owner.getRepository(SignalBindingVersion).create({
        tenantId: 'acme', sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'EG-1', componentId: '', origin: 'physical',
        imei, canonicalUnit, validFrom: new Date('2026-11-01T00:00:00.000Z'), validTo: null,
        isPrimary: true, status: 'active', signalKey: role, measurementRole: role,
      }));
      await bind('coolant_temp_c', 'IMEI-1', 'degC');
      await bind('oil_pressure_kpa', 'IMEI-1', 'kPa');
    });

    it('a whole-machine binding covers the one component the type names for that signal', async () => {
      const result = await app.get(SignalBindingService).coverage(acme, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'EG-1' }, AT);
      expect(result.covered.find((c) => c.measurementRole === 'coolant_temp_c'))
        .toMatchObject({ componentScope: 'engine', activeCount: 1 });
    });

    it('but not one of two components: it cannot say which side it is', async () => {
      const result = await app.get(SignalBindingService).coverage(acme, { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'EG-1' }, AT);
      const oil = result.missing.filter((c) => c.measurementRole === 'oil_pressure_kpa').map((c) => c.componentScope).sort();
      expect(oil).toEqual(['left', 'right']);
    });
  });

  describe('TC_295: a fitted logger that is not mapped yet', () => {
    const SOURCE = 'iot-platform-1';
    const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

    beforeEach(async () => {
      for (const t of ['device_inventory_event', 'device_inventory', 'signal_binding_version', 'equipment_profile',
        'client_scenario', 'client_equipment_class']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await runTenantSpanning(owner, 'test fixture', async (m) => {
        await m.getRepository(ClientEquipmentClass).save({
          tenantId: 'acme', slug: 'diesel-generator', name: 'Diesel generator', description: null, category: 'power',
          expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: 'diesel-generator',
          templateVersion: 1, templateChecksum: 'c', copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        });
        await m.getRepository(ClientScenario).save({
          tenantId: 'acme', slug: 'fuel-theft', clientEquipmentClassSlug: 'diesel-generator', name: 'Fuel theft',
          description: null, severity: 'high', tier: 1, requiredSignals: ['fuel_level'], minimumHistoryDays: 0,
          parameters: [], enabled: true, templateSlug: 'fuel-theft', templateVersion: 1, templateChecksum: 'c',
          copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        } as never);
        await m.getRepository(EquipmentProfile).save({
          tenantId: 'acme', sourceSystem: SOURCE, externalId: 'DG-1', equipmentClassSlug: 'diesel-generator',
          classVersion: 1, tier: 'standard', commissionedAt: null, serviceIntervalHours: null, readiness: {}, updatedBy: 'u-acme',
        });
      });
    });

    const blockers = async () => (await app.get(RecommendationService).forEquipment(acme, SOURCE, 'DG-1', NOW))
      .recommendations.find((r) => r.scenarioSlug === 'fuel-theft')!.blockedBy.map((b) => b.code);

    it('is a device: the scenario waits on its signals, not on fitting one', async () => {
      await owner.query(
        `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('L-DG', 'acme', 'assigned', 'DG-1')`,
      );
      const codes = await blockers();
      expect(codes).not.toContain('no-device');
      expect(codes).toContain('missing-signals');
    });

    it('with nothing fitted it is still "no device"', async () => {
      expect(await blockers()).toContain('no-device');
    });

    it('a logger fitted to a machine in another account does not count', async () => {
      await owner.query(
        `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('L-X', 'globex', 'assigned', 'DG-1')`,
      );
      expect(await blockers()).toContain('no-device');
    });
  });

  describe('TC_287: an import whose class row was rejected', () => {
    beforeEach(async () => {
      await owner.query(
        `TRUNCATE TABLE "catalog_import_row", "catalog_import_batch", "equipment_class_formula",
          "equipment_class_sensor_requirement", "equipment_class_profile" RESTART IDENTITY CASCADE`,
      );
    });

    const batchWith = async (rows: { sheet: string; rowNumber: number; payload: Record<string, unknown>; status: string }[]) => {
      const [{ id }] = await owner.query(
        `INSERT INTO catalog_import_batch (filename, checksum_sha256, template_version, uploaded_by, status)
           VALUES ('x.xlsx', 'abc', '1', 'u-master', 'validated') RETURNING id`,
      );
      for (const r of rows) {
        await owner.query(
          `INSERT INTO catalog_import_row (batch_id, sheet, row_number, entity_kind, payload, status)
             VALUES ($1, $2, $3, $2, $4::jsonb, $5)`,
          [id, r.sheet, r.rowNumber, JSON.stringify(r.payload), r.status],
        );
      }
      return id as string;
    };

    it('refuses to apply its other rows, and writes nothing', async () => {
      const id = await batchWith([
        { sheet: 'equipment_class', rowNumber: 2, payload: { slug: 'crusher-x', name: 'Crusher X' }, status: 'invalid' },
        { sheet: 'signal', rowNumber: 2, payload: { class_slug: 'crusher-x', signal: 'motor_temp_c', unit: 'degC', required: true }, status: 'valid' },
      ]);
      await expect(app.get(CatalogImportApplyService).apply(id, 'u-master'))
        .rejects.toThrow(/machine type row for "crusher-x" \(equipment_class row 2\) was rejected/);
      expect((await owner.query(`SELECT count(*)::int AS n FROM equipment_class_profile WHERE slug = 'crusher-x'`))[0].n).toBe(0);
      expect((await owner.query(`SELECT status FROM catalog_import_batch WHERE id = $1`, [id]))[0].status).toBe('validated');
    });
  });

  describe('TC_276: a type made on the New Class form, with a signal list and no requirement rows', () => {
    const AT = new Date('2026-11-27T12:00:00.000Z');
    const machine = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'FG-1' };

    beforeEach(async () => {
      for (const t of ['signal_binding_version', 'equipment_class_sensor_requirement', 'equipment_profile', 'equipment_class_profile']) {
        await owner.query(`DELETE FROM "${t}"`);
      }
      await owner.getRepository(EquipmentClassProfile).save(owner.getRepository(EquipmentClassProfile).create({
        slug: 'form-genset', version: 1, name: 'Form genset', status: 'published',
        // As the form saves it, with a blank row and a repeat a form can leave behind.
        expectedSignals: [
          { signal: 'coolant_temp_c', unit: 'degC', required: true },
          { signal: 'engine_rpm', unit: 'rpm', required: false },
          { signal: ' ', unit: null, required: true },
          { signal: 'coolant_temp_c', unit: 'degC', required: false },
        ],
      } as never));
      await owner.getRepository(EquipmentProfile).save(owner.getRepository(EquipmentProfile).create({
        tenantId: 'acme', ...machine, equipmentClassSlug: 'form-genset', classVersion: 1, name: 'FG-1',
      }));
    });

    const coverage = () => app.get(SignalBindingService).coverage(acme, machine, AT);

    it('asks for its required signals, so mapping has something to map', async () => {
      const result = await coverage();
      expect(result.missing.map((r) => [r.measurementRole, r.reason])).toEqual([['coolant_temp_c', 'unbound']]);
      expect(result.covered).toEqual([]);
    });

    it('and counts one bound', async () => {
      await owner.getRepository(SignalBindingVersion).save(owner.getRepository(SignalBindingVersion).create({
        tenantId: 'acme', ...machine, componentId: '', origin: 'physical', imei: 'IMEI-FG', canonicalUnit: 'degC',
        validFrom: new Date('2026-11-01T00:00:00.000Z'), validTo: null, isPrimary: true, status: 'active',
        signalKey: 'coolant_temp_c', measurementRole: 'coolant_temp_c',
      }));
      const result = await coverage();
      expect(result.covered.map((r) => r.measurementRole)).toEqual(['coolant_temp_c']);
      expect(result.missing).toEqual([]);
    });

    it('a version with any requirement row says what it requires: the list is not read', async () => {
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, criticality)
           VALUES ('form-genset', 1, 'engine_rpm', 'optional')`,
      );
      const result = await coverage();
      expect(result.missing).toEqual([]);
      expect(result.covered).toEqual([]);
    });
  });

  describe('TC_277: the Add Sensor form', () => {
    beforeEach(async () => {
      await owner.query(`TRUNCATE TABLE "sensor_role_capability", "sensor" RESTART IDENTITY CASCADE`);
    });

    const spec = (parameter: string, signal?: string) => ({
      parameter, unit: 'degC', min: 0, max: 120, normalRange: '70-95', ...(signal !== undefined ? { signal } : {}),
    });
    const links = async (sensorId: string) => owner.query(
      `SELECT measurement_role AS role, parameter_key AS parameter, canonical_unit AS unit
         FROM sensor_role_capability WHERE sensor_id = $1 ORDER BY parameter_key`, [sensorId],
    );

    it('links each parameter that names a signal, and only those', async () => {
      const sensor = await app.get(DeviceCatalogService).createSensor({
        sensorName: 'Coolant probe', parameterSpecs: [spec('Coolant', ' coolant_temp_c '), spec('Spare'), spec('Blank', '  ')],
      });
      expect(await links(sensor.id)).toEqual([{ role: 'coolant_temp_c', parameter: 'Coolant', unit: 'degC' }]);
      expect(sensor.parameterSpecs.map((s) => s.signal)).toEqual(['coolant_temp_c', undefined, undefined]);
    });

    it('a changed signal moves the link rather than adding a second one; saving again adds nothing', async () => {
      const catalog = app.get(DeviceCatalogService);
      const sensor = await catalog.createSensor({ sensorName: 'Coolant probe', parameterSpecs: [spec('Coolant', 'coolant_temp_c')] });
      await catalog.updateSensor(sensor.id, { parameterSpecs: [spec('Coolant', 'engine_coolant_temp_c')] });
      await catalog.updateSensor(sensor.id, { parameterSpecs: [spec('Coolant', 'engine_coolant_temp_c')] });
      expect(await links(sensor.id)).toEqual([{ role: 'engine_coolant_temp_c', parameter: 'Coolant', unit: 'degC' }]);
    });

    it('editing only the description leaves the links as they are', async () => {
      const catalog = app.get(DeviceCatalogService);
      const sensor = await catalog.createSensor({ sensorName: 'Coolant probe', parameterSpecs: [spec('Coolant', 'coolant_temp_c')] });
      await catalog.updateSensor(sensor.id, { description: 'New text' });
      expect(await links(sensor.id)).toHaveLength(1);
    });
  });

  // Last: it undoes and re-applies the newest migration.
  describe('TC_276: the backfill for types made before the form wrote requirements', () => {
    const MIGRATION = 'RequirementsFromSignals1766500000000';
    const rows = async (slug: string) => (await owner.query(
      `SELECT measurement_role AS role, criticality, canonical_unit AS unit
         FROM equipment_class_sensor_requirement WHERE class_slug = $1 ORDER BY measurement_role`, [slug],
    ));

    beforeAll(async () => {
      await owner.query(
        `TRUNCATE TABLE "equipment_class_formula", "equipment_class_sensor_requirement", "equipment_class_profile" RESTART IDENTITY CASCADE`,
      );
      await undoMigrationNamed(owner, MIGRATION);
      const profile = (slug: string, expectedSignals: unknown[]) => owner.getRepository(EquipmentClassProfile).save(
        owner.getRepository(EquipmentClassProfile).create({ slug, version: 1, name: slug, status: 'published', expectedSignals } as never),
      );
      // Made on the form: a list, no rows. One blank row and one repeat, as a form can leave them.
      await profile('form-made', [
        { signal: 'coolant_temp_c', unit: 'degC', required: true },
        { signal: 'engine_rpm', unit: '', required: false },
        { signal: '  ', unit: null, required: true },
        { signal: 'coolant_temp_c', unit: 'degC', required: false },
      ]);
      // Imported: its rows already say what it requires, and one listed signal is left out on purpose.
      await profile('imported', [
        { signal: 'oil_pressure_kpa', unit: 'kPa', required: true },
        { signal: 'fuel_level_pct', unit: '%', required: true },
      ]);
      await owner.query(
        `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, criticality, source)
           VALUES ('imported', 1, 'oil_pressure_kpa', 'required', 'excel-import')`,
      );
      await owner.runMigrations({ transaction: 'all' });
    });

    it('writes the form-made type its requirements, published as it is', async () => {
      expect(await rows('form-made')).toEqual([
        { role: 'coolant_temp_c', criticality: 'required', unit: 'degC' },
        { role: 'engine_rpm', criticality: 'recommended', unit: null },
      ]);
    });

    it('leaves a type that already has requirement rows as it was', async () => {
      expect(await rows('imported')).toEqual([{ role: 'oil_pressure_kpa', criticality: 'required', unit: null }]);
    });

    it('down removes what it wrote and nothing else', async () => {
      await undoMigrationNamed(owner, MIGRATION);
      expect(await rows('form-made')).toEqual([]);
      expect(await rows('imported')).toHaveLength(1);
      await owner.runMigrations({ transaction: 'all' });
    });
  });
});
