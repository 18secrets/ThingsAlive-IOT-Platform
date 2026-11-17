import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { DtcEpisodeService } from '../src/diagnostics/services/dtc-episode.service';
import { upsertMasterDefinitions } from '../src/diagnostics/services/dtc-master-catalog';
import { FaultCodeLibraryService } from '../src/diagnostics/services/fault-code-library.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { Severity } from '../src/common/severity';
import { Workbook } from 'exceljs';
import { COLUMNS, parseCodeWorkbook } from '../src/diagnostics/services/fault-code-workbook';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'FaultCodeLibrary1765300000000';
const EDITING = 'FaultCodeEditing1765400000000';

jest.setTimeout(60_000);

/**
 * The fault code library, step 1: vehicle codes and motor codes in tables of their own,
 * and which kinds of code each account is given. Every rule here is shown by trying the
 * forbidden thing — an account writing itself a grant, a P-code put back in the vehicle
 * table, 1.0's copy landing on a 2.0 code — and watching the database or the service
 * refuse it.
 */
describeDb('fault code library, against the database', () => {
  let owner: DataSource;
  let ds: DataSource;
  let library: FaultCodeLibraryService;
  let faults: DtcEpisodeService;
  const master: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };
  const motors: RequestScope = { tenantId: 'motors', userId: 'u-motors', roles: ['super admin'], isPlatformRole: false };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    library = new FaultCodeLibraryService(ds);
    faults = new DtcEpisodeService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /** Writes as the daily copy from 1.0 does: the only writer the guard lets touch a 1.0 row. */
  const asSync = (sql: string, params: unknown[] = []) => owner.transaction(async (m) => {
    await m.query(`SELECT set_config('ta.fault_code_sync', 'on', true)`);
    return m.query(sql, params);
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "fault_code_type_grant", "device_dtc_episode", "device_inventory", "device_projection" CASCADE`);
    // TRUNCATE, not DELETE: the table refuses deletes (dtc_master_owner_guard).
    await owner.query(`TRUNCATE "dtc_master_catalog", "fault_code_revision"`);
    for (const [id, name] of [['motors', 'Motors'], ['acme', 'Acme']]) {
      await owner.query(`INSERT INTO "tenant" ("tenant_id", "name") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, name]);
    }
  });

  describe('two tables', () => {
    it('the six P-codes live in the motor table, with the symptom the hardware team gave', async () => {
      const rows = await owner.query(`SELECT code, symptom, found_by FROM fault_code_motor ORDER BY code`);
      expect(rows.map((r: { code: string }) => r.code)).toEqual(['P101', 'P102', 'P207', 'P401', 'P702', 'P708']);
      expect(rows.find((r: { code: string }) => r.code === 'P401')).toMatchObject({ symptom: 'Runs, but no water; overheating', found_by: 'logger' });
    });

    it('the vehicle table refuses a P-code, and a row that is neither 1.0\'s nor 2.0\'s', async () => {
      await expect(asSync(
        `INSERT INTO dtc_master_catalog (protocol, code, description) VALUES ('pcode', 'P999', 'x')`,
      )).rejects.toThrow(/ck_dtc_master_protocol/);
      await expect(asSync(
        `INSERT INTO dtc_master_catalog (protocol, code, description, source_system) VALUES ('obd2', 'P0101', 'x', 'pump-logger')`,
      )).rejects.toThrow(/ck_dtc_master_source/);
    });

    it('the motor table refuses a code that is not P and three digits', async () => {
      await expect(owner.query(`INSERT INTO fault_code_motor (code, description) VALUES ('P0101', 'x')`))
        .rejects.toThrow(/ck_motor_fault_code_code/);
    });

    it('the machine page reads a pump\'s code from the motor table, symptom included', async () => {
      await library.grant(master, 'motors', 'motor-pump');
      await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'motors', 'assigned', 'PUMP-1')`);
      await owner.query(
        `INSERT INTO device_dtc_episode (tenant_id, source_system, external_id, imei, protocol, code, status, first_seen_at, last_seen_at)
         VALUES ('motors', 'ta-2.0', 'PUMP-1', 'MOTOR_001', 'pcode', 'P708', 'active', now(), now())`);
      const shown = await faults.getEquipmentFaults('motors', 'ta-2.0', 'PUMP-1');
      expect(shown.active[0]).toMatchObject({
        code: 'P708', description: 'Locked rotor', lamp: 'red_stop', severity: 'critical',
        symptom: 'Motor hums; very high current and little or no water',
      });
      expect(shown.active[0].remedies).toMatch(/capacitor/);
    });

    it('a code from 1.0 keeps the unit that raised it and the maker\'s own code, and the library shows both', async () => {
      await upsertMasterDefinitions(ds, [{
        protocol: 'j1939', code: 'SPN:177:FMI:16', spn: 177, fmi: 16, description: 'Transmission oil temperature high',
        lamp: 'red_stop', severity: Severity.Critical, causes: null, remedies: null, sourceUnit: 'TCU', oemCode: 'E-4402',
      }]);
      const [code] = (await library.codes('vehicle-j1939', {})).codes;
      expect(code).toMatchObject({ code: 'SPN:177:FMI:16', system: 'TCU', oemCode: 'E-4402', source: '1.0' });
      const [motor] = (await library.codes('motor-pump', { limit: 1 })).codes;
      expect(motor).toMatchObject({ system: null, oemCode: null });
    });

    it('1.0\'s daily copy updates its own vehicle rows, never one 2.0 holds, and never a motor code', async () => {
      await owner.query(
        `INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description, source_system)
         VALUES ('j1939', 'SPN:100:FMI:1', 100, 1, '2.0 wording', '2.0')`);
      await asSync(
        `INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description, source_system)
         VALUES ('j1939', 'SPN:110:FMI:0', 110, 0, 'old 1.0 wording', '1.0')`);
      const definition = (code: string, spn: number, fmi: number, description: string) => ({
        protocol: 'j1939' as const, code, spn, fmi, description, lamp: 'amber_warning' as const,
        severity: Severity.High, causes: null, remedies: null,
      });
      await upsertMasterDefinitions(ds, [
        definition('SPN:100:FMI:1', 100, 1, '1.0 wording'), definition('SPN:110:FMI:0', 110, 0, 'new 1.0 wording'),
      ]);
      const text = async (code: string) => (await owner.query(`SELECT description FROM dtc_master_catalog WHERE code = $1`, [code]))[0].description;
      expect(await text('SPN:100:FMI:1')).toBe('2.0 wording');
      expect(await text('SPN:110:FMI:0')).toBe('new 1.0 wording');
      expect(await owner.query(`SELECT 1 FROM fault_code_motor`)).toHaveLength(6);
    });
  });

  describe('the machine page follows Account access', () => {
    const pumpFault = () => owner.query(
      `INSERT INTO device_dtc_episode (tenant_id, source_system, external_id, imei, protocol, code, status, first_seen_at, last_seen_at)
       VALUES ('motors', 'ta-2.0', 'PUMP-1', 'MOTOR_001', 'pcode', 'P708', 'active', now(), now())`);

    beforeEach(async () => {
      await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES ('MOTOR_001', 'motors', 'assigned', 'PUMP-1')`);
    });

    it('a code of a kind the account was not given still shows, as its bare code with no title, cause or fix', async () => {
      await pumpFault();
      const [shown] = (await faults.getEquipmentFaults('motors', 'ta-2.0', 'PUMP-1')).active;
      expect(shown).toMatchObject({ code: 'P708', description: 'P708', symptom: null, causes: null, remedies: null });
    });

    it('given the kind, the same code reads in full; revoked, it is bare again', async () => {
      await pumpFault();
      const grant = await library.grant(master, 'motors', 'motor-pump');
      expect((await faults.getEquipmentFaults('motors', 'ta-2.0', 'PUMP-1')).active[0].description).toBe('Locked rotor');
      await library.revoke(master, grant.id);
      expect((await faults.getEquipmentFaults('motors', 'ta-2.0', 'PUMP-1')).active[0].description).toBe('P708');
    });

    it('another account\'s grant does not give this account the meaning', async () => {
      await pumpFault();
      await library.grant(master, 'acme', 'motor-pump');
      expect((await faults.getEquipmentFaults('motors', 'ta-2.0', 'PUMP-1')).active[0].description).toBe('P708');
    });
  });

  describe('which kinds an account is given', () => {
    it('an account given the pump kind reads its codes; a kind it was not given is not found', async () => {
      await library.grant(master, 'motors', 'motor-pump');
      expect(await library.myTypes(motors)).toEqual([{ type: 'motor-pump', total: 6 }]);
      expect((await library.myCodes(motors, 'motor-pump', {})).codes.map((c) => c.code)).toContain('P708');
      await expect(library.myCodes(motors, 'vehicle-j1939', {})).rejects.toThrow(NotFoundException);
      // Another account, given nothing, cannot read the kind Motors was given.
      await expect(library.myCodes(acme, 'motor-pump', {})).rejects.toThrow(NotFoundException);
      expect(await library.myTypes(acme)).toEqual([]);
    });

    it('an account cannot write itself a grant: the database refuses it in the account\'s own session', async () => {
      await expect(withTenantId(ds, 'acme', (m) => m.query(
        `INSERT INTO fault_code_type_grant (tenant_id, code_type, granted_by) VALUES ('acme', 'motor-pump', 'u-acme')`,
      ))).rejects.toThrow(/row-level security/);
    });

    it('an account reads its own grants and nobody else\'s', async () => {
      await library.grant(master, 'motors', 'motor-pump');
      await library.grant(master, 'acme', 'vehicle-j1939');
      const seen = await withTenantId(ds, 'acme', (m) => m.query(`SELECT tenant_id FROM fault_code_type_grant`));
      expect(seen).toEqual([{ tenant_id: 'acme' }]);
    });

    it('two grants fired together both settle and leave one grant', async () => {
      const results = await Promise.allSettled([
        library.grant(master, 'motors', 'motor-pump'), library.grant(master, 'motors', 'motor-pump'),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const ids = results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
      expect(ids[0]).toBe(ids[1]);
      expect(await owner.query(`SELECT 1 FROM fault_code_type_grant`)).toHaveLength(1);
    });

    it('revoked, the kind is gone from the account; granted again, the same row comes back', async () => {
      const first = await library.grant(master, 'motors', 'motor-pump');
      const revoked = await library.revoke(master, first.id);
      expect(revoked.revokedBy).toBe('deepak');
      await expect(library.myCodes(motors, 'motor-pump', {})).rejects.toThrow(NotFoundException);
      await expect(library.revoke(master, first.id)).rejects.toThrow(NotFoundException);
      const again = await library.grant(master, 'motors', 'motor-pump');
      expect(again.id).toBe(first.id);
      expect(again.revokedAt).toBeNull();
    });

    it('a kind that does not exist, or an account that does not, is refused', async () => {
      await expect(library.grant(master, 'motors', 'motor-generator')).rejects.toThrow(/not a kind of fault code/);
      await expect(library.grant(master, 'nobody', 'motor-pump')).rejects.toThrow(/No account "nobody"/);
    });

    it('vehicle codes are searched and paged; retired motor codes are Master Admin\'s to see', async () => {
      await asSync(
        `INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description)
         SELECT 'j1939', 'SPN:' || n || ':FMI:1', n, 1, 'Coolant temperature ' || n FROM generate_series(1, 30) n`);
      const page = await library.codes('vehicle-j1939', { q: 'coolant', limit: 10, offset: 10 });
      expect(page).toMatchObject({ type: 'vehicle-j1939', total: 30 });
      expect(page.codes).toHaveLength(10);
      expect(page.codes[0]).toMatchObject({ source: '1.0', symptom: null });
      await owner.query(`UPDATE fault_code_motor SET retired_at = now() WHERE code = 'P102'`);
      try {
        await library.grant(master, 'motors', 'motor-pump');
        expect((await library.myCodes(motors, 'motor-pump', {})).total).toBe(5);
        expect((await library.codes('motor-pump', { includeRetired: true })).total).toBe(6);
      } finally {
        await owner.query(`UPDATE fault_code_motor SET retired_at = NULL WHERE code = 'P102'`);
      }
    });
  });

  describe('editing the codes 2.0 owns', () => {
    const motorId = async (code: string) => (await owner.query(`SELECT id FROM fault_code_motor WHERE code = $1`, [code]))[0].id as string;
    const historyOf = async (type: string, id: string) => (await library.history(type, id)).map((h) => `${h.field}: ${h.oldValue} -> ${h.newValue}`);

    afterEach(async () => {
      // The six P-codes are the migration's; put back what a test changed or added.
      await owner.query(`DELETE FROM fault_code_motor WHERE code NOT IN ('P101', 'P102', 'P207', 'P401', 'P702', 'P708')`);
      await owner.query(
        `UPDATE fault_code_motor SET retired_at = NULL, symptom = 'Runs, but no water; overheating', severity = 'critical' WHERE code = 'P401'`);
    });

    it('a new motor code is added and its history starts; a code already there, or not P and three digits, is refused', async () => {
      const added = await library.create(master, 'motor-pump', {
        code: 'p103', description: 'Voltage fluctuation', symptom: 'Speed varies, repeated trips', foundBy: 'logger', severity: 'high', lamp: 'amber_warning',
      });
      expect(added).toMatchObject({ code: 'P103', description: 'Voltage fluctuation', source: '2.0', severity: 'high' });
      expect(await historyOf('motor-pump', added.id)).toEqual(['created: null -> Voltage fluctuation']);
      await expect(library.create(master, 'motor-pump', { code: 'P101', description: 'x' })).rejects.toThrow(ConflictException);
      await expect(library.create(master, 'motor-pump', { code: 'P1', description: 'x' })).rejects.toThrow(BadRequestException);
      await expect(library.create(master, 'motor-pump', { code: 'P104' })).rejects.toThrow(/fault title/);
    });

    it('an edit writes each changed field to the history, and an edit that changes nothing writes nothing', async () => {
      const id = await motorId('P401');
      await library.update(master, 'motor-pump', id, { symptom: 'Runs dry, no water', severity: 'high' });
      await library.update(master, 'motor-pump', id, { symptom: 'Runs dry, no water', severity: 'high' });
      expect((await historyOf('motor-pump', id)).sort()).toEqual([
        'severity: critical -> high', 'symptom: Runs, but no water; overheating -> Runs dry, no water',
      ]);
      await expect(library.update(master, 'motor-pump', id, { severity: 'urgent' })).rejects.toThrow(/severity must be/);
    });

    it('two identical edits fired together both settle and are written to the history once', async () => {
      const id = await motorId('P401');
      const results = await Promise.allSettled([
        library.update(master, 'motor-pump', id, { severity: 'medium' }), library.update(master, 'motor-pump', id, { severity: 'medium' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await historyOf('motor-pump', id)).toEqual(['severity: critical -> medium']);
    });

    it('a retired code leaves the account\'s list and comes back when restored, both in the history', async () => {
      await library.grant(master, 'motors', 'motor-pump');
      const id = await motorId('P401');
      await library.setRetired(master, 'motor-pump', id, true);
      expect((await library.myCodes(motors, 'motor-pump', {})).codes.map((c) => c.code)).not.toContain('P401');
      await library.setRetired(master, 'motor-pump', id, false);
      expect((await library.myCodes(motors, 'motor-pump', {})).codes.map((c) => c.code)).toContain('P401');
      expect(await historyOf('motor-pump', id)).toEqual(['retired: yes -> no', 'retired: no -> yes']);
    });

    it('a 2.0 vehicle code is added, edited and retired; one 1.0 already has is refused', async () => {
      await asSync(`INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description) VALUES ('j1939', 'SPN:177:FMI:16', 177, 16, 'From 1.0')`);
      await expect(library.create(master, 'vehicle-j1939', { spn: 177, fmi: 16, description: 'Mine' })).rejects.toThrow(ConflictException);
      const added = await library.create(master, 'vehicle-j1939', { spn: 523, fmi: 2, description: 'Gear selector erratic' });
      expect(added).toMatchObject({ code: 'SPN:523:FMI:2', spn: 523, fmi: 2, source: '2.0' });
      const edited = await library.update(master, 'vehicle-j1939', added.id, { remedies: 'Check the selector harness' });
      expect(edited.remedies).toBe('Check the selector harness');
      expect((await library.setRetired(master, 'vehicle-j1939', added.id, true)).retiredAt).not.toBeNull();
      await expect(library.create(master, 'vehicle-obd2', { code: 'X1', description: 'x' })).rejects.toThrow(/OBD-II code/);
    });

    it('a 1.0 vehicle code is refused an edit by the service, and by the database however it is written', async () => {
      await asSync(`INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description) VALUES ('j1939', 'SPN:177:FMI:16', 177, 16, 'From 1.0')`);
      const [{ id }] = await owner.query(`SELECT id FROM dtc_master_catalog WHERE code = 'SPN:177:FMI:16'`);
      await expect(library.update(master, 'vehicle-j1939', id, { description: 'Mine' })).rejects.toThrow(/is 1.0's/);
      await expect(owner.query(`UPDATE dtc_master_catalog SET description = 'Mine' WHERE id = $1`, [id])).rejects.toThrow(/is 1.0's/);
      await expect(owner.query(`UPDATE dtc_master_catalog SET source_system = '2.0' WHERE id = $1`, [id])).rejects.toThrow(/cannot change hands/);
      await expect(owner.query(`DELETE FROM dtc_master_catalog WHERE id = $1`, [id])).rejects.toThrow(/retired, not deleted/);
    });

    it('the copy from 1.0 is refused a 2.0 vehicle code by the database', async () => {
      const added = await library.create(master, 'vehicle-j1939', { spn: 523, fmi: 2, description: 'Gear selector erratic' });
      await expect(asSync(`UPDATE dtc_master_catalog SET description = 'From 1.0' WHERE id = $1`, [added.id])).rejects.toThrow(/is 2.0's/);
    });

    it('the history cannot be rewritten from the application', async () => {
      const id = await motorId('P401');
      await library.update(master, 'motor-pump', id, { severity: 'high' });
      await expect(runTenantSpanning(ds, 'test: rewrite history', (m) => m.query(`UPDATE fault_code_revision SET new_value = 'low'`)))
        .rejects.toThrow(/permission denied/);
      await expect(runTenantSpanning(ds, 'test: erase history', (m) => m.query(`DELETE FROM fault_code_revision`)))
        .rejects.toThrow(/permission denied/);
    });
  });

  describe('bulk import from a workbook', () => {
    /** A workbook as the template lays it out, with these rows under the headers. */
    const workbook = async (type: keyof typeof COLUMNS, rows: Record<string, string | number>[], headers = Object.values(COLUMNS[type])) => {
      const book = new Workbook();
      const sheet = book.addWorksheet('Codes');
      sheet.addRow(headers);
      const fields = Object.keys(COLUMNS[type]);
      for (const r of rows) sheet.addRow(fields.map((f) => r[f] ?? ''));
      return Buffer.from(await book.xlsx.writeBuffer());
    };
    const motorCode = async (code: string) => (await owner.query(`SELECT * FROM fault_code_motor WHERE code = $1`, [code]))[0];

    afterEach(async () => {
      await owner.query(`DELETE FROM fault_code_motor WHERE code NOT IN ('P101', 'P102', 'P207', 'P401', 'P702', 'P708')`);
      await owner.query(`UPDATE fault_code_motor SET symptom = 'Runs, but no water; overheating', severity = 'critical', found_by = 'logger' WHERE code = 'P401'`);
    });

    it('the template holds one example row, not the library, and that row reads as a valid code', async () => {
      for (const type of ['motor-pump', 'vehicle-j1939', 'vehicle-obd2'] as const) {
        const template = await library.template(type);
        expect(await parseCodeWorkbook(type, template)).toHaveLength(1);
        const checked = await library.importCodes(master, type, template, false);
        expect(checked.summary).toEqual({ new: 1, changed: 0, unchanged: 0, errors: 0 });
      }
    });

    it('a check names each row new, changed, unchanged or in error, and writes nothing', async () => {
      const file = await workbook('motor-pump', [
        { code: 'P103', description: 'Voltage fluctuation', severity: 'Warning', foundBy: 'Logger' },
        { code: 'P401', symptom: 'Runs dry' },
        { code: 'P101' },
        { code: 'P1', description: 'x' },
        { code: 'p103', description: 'again' },
        { code: 'P104', description: 'Voltage drop at start', severity: 'Urgent' },
        { code: 'P105' },
      ]);
      const checked = await library.importCodes(master, 'motor-pump', file, false);
      expect(checked.applied).toBe(false);
      expect(checked.summary).toEqual({ new: 1, changed: 1, unchanged: 1, errors: 4 });
      expect(checked.rows.map((r) => `${r.code}:${r.status}`)).toEqual([
        'P103:new', 'P401:changed', 'P101:unchanged', 'P1:error', 'P103:error', 'P104:error', 'P105:error',
      ]);
      expect(checked.rows[1].changes).toEqual([{ field: 'symptom', from: 'Runs, but no water; overheating', to: 'Runs dry' }]);
      expect(checked.rows[4].error).toMatch(/same code as row 2/);
      expect(checked.rows[5].error).toMatch(/severity must be/);
      expect(checked.rows[6].error).toMatch(/fault title/);
      expect(await motorCode('P103')).toBeUndefined();
    });

    it('a file with an error in any row is refused whole', async () => {
      const file = await workbook('motor-pump', [{ code: 'P103', description: 'Voltage fluctuation' }, { code: 'P1', description: 'x' }]);
      const result = await library.importCodes(master, 'motor-pump', file, true);
      expect(result.applied).toBe(false);
      expect(await motorCode('P103')).toBeUndefined();
    });

    it('applied: new codes added and changed ones edited, in the sheet\'s words, each with its history; a blank cell is left alone', async () => {
      const file = await workbook('motor-pump', [
        { code: 'P103', description: 'Voltage fluctuation', symptom: 'Speed varies, repeated trips', severity: 'Warning', lamp: 'Amber warning', foundBy: 'Logger' },
        { code: 'P401', symptom: 'Runs dry', foundBy: 'Technician' },
      ]);
      const result = await library.importCodes(master, 'motor-pump', file, true);
      expect(result).toMatchObject({ applied: true, summary: { new: 1, changed: 1, unchanged: 0, errors: 0 } });
      expect(await motorCode('P103')).toMatchObject({ description: 'Voltage fluctuation', severity: 'high', lamp: 'amber_warning', found_by: 'logger' });
      // P401's description, causes and fix were blank in the sheet: they are as they were.
      expect(await motorCode('P401')).toMatchObject({ description: 'Dry run', symptom: 'Runs dry', found_by: 'technician', severity: 'critical' });
      const fields = (await owner.query(`SELECT code, field FROM fault_code_revision ORDER BY code, field`)).map((r: { code: string; field: string }) => `${r.code}.${r.field}`);
      expect(fields).toEqual(['P103.created', 'P401.found_by', 'P401.symptom']);
    });

    it('the same file applied twice changes nothing the second time', async () => {
      const file = await workbook('motor-pump', [{ code: 'P103', description: 'Voltage fluctuation' }, { code: 'P401', symptom: 'Runs dry' }]);
      await library.importCodes(master, 'motor-pump', file, true);
      const again = await library.importCodes(master, 'motor-pump', file, true);
      expect(again).toMatchObject({ applied: false, summary: { new: 0, changed: 0, unchanged: 2, errors: 0 } });
      expect(await owner.query(`SELECT 1 FROM fault_code_revision`)).toHaveLength(2);
    });

    it('two applies of one file fired together both settle and add each code once', async () => {
      const file = await workbook('motor-pump', [{ code: 'P103', description: 'Voltage fluctuation' }, { code: 'P401', symptom: 'Runs dry' }]);
      const results = await Promise.allSettled([
        library.importCodes(master, 'motor-pump', file, true), library.importCodes(master, 'motor-pump', file, true),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(results.map((r) => (r as PromiseFulfilledResult<{ applied: boolean }>).value.applied).sort()).toEqual([false, true]);
      expect(await owner.query(`SELECT 1 FROM fault_code_motor WHERE code = 'P103'`)).toHaveLength(1);
      expect(await owner.query(`SELECT 1 FROM fault_code_revision`)).toHaveLength(2);
    });

    it('a vehicle sheet adds 2.0 codes and refuses a row for a code 1.0 owns', async () => {
      await asSync(`INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description) VALUES ('j1939', 'SPN:177:FMI:16', 177, 16, 'From 1.0')`);
      const refused = await library.importCodes(master, 'vehicle-j1939', await workbook('vehicle-j1939', [
        { spn: 523, fmi: 2, description: 'Gear selector erratic', severity: 'Critical', lamp: 'Red stop' },
        { spn: 177, fmi: 16, description: 'Mine' },
      ]), true);
      expect(refused.applied).toBe(false);
      expect(refused.rows[1].error).toMatch(/is 1.0's/);
      const applied = await library.importCodes(master, 'vehicle-j1939', await workbook('vehicle-j1939', [
        { spn: 523, fmi: 2, description: 'Gear selector erratic', severity: 'Critical', lamp: 'Red stop' },
      ]), true);
      expect(applied.applied).toBe(true);
      expect((await owner.query(`SELECT source_system, severity, lamp FROM dtc_master_catalog WHERE code = 'SPN:523:FMI:2'`))[0])
        .toEqual({ source_system: '2.0', severity: 'critical', lamp: 'red_stop' });
    });

    it('a file that is not a workbook, or not this kind\'s, is refused before any row is read', async () => {
      await expect(library.importCodes(master, 'motor-pump', Buffer.from('not a workbook'), false)).rejects.toThrow(/not an Excel workbook/);
      await expect(library.importCodes(master, 'motor-pump', await workbook('vehicle-j1939', [{ spn: 1, fmi: 1 }]), false))
        .rejects.toThrow(/no "Code" column/);
    });
  });

  it(`${EDITING} comes off and goes back on`, async () => {
    await asSync(`INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description) VALUES ('j1939', 'SPN:9:FMI:9', 9, 9, 'x')`);
    await undoMigrationNamed(owner, EDITING);
    expect(await owner.query(`SELECT to_regclass('fault_code_revision') AS t`)).toEqual([{ t: null }]);
    // No guard: a plain update of a 1.0 row goes through, as it did before.
    await owner.query(`UPDATE dtc_master_catalog SET description = 'edited' WHERE code = 'SPN:9:FMI:9'`);
    await owner.runMigrations({ transaction: 'all' });
    await expect(owner.query(`UPDATE dtc_master_catalog SET description = 'again' WHERE code = 'SPN:9:FMI:9'`)).rejects.toThrow(/is 1.0's/);
  });

  it(`${MIGRATION} comes off and goes back on, giving today's accounts what they see today`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    // Before: the P-codes back in the vehicle table, the motor table and grants gone.
    expect(await owner.query(`SELECT 1 FROM dtc_master_catalog WHERE protocol = 'pcode'`)).toHaveLength(6);
    expect(await owner.query(`SELECT to_regclass('fault_code_motor') AS t`)).toEqual([{ t: null }]);
    // An account with a 1.0 device, and one with a pump logger.
    await owner.query(`INSERT INTO device_projection (source_system, external_id, tenant_id, checksum, imei) VALUES ('iot-platform-1', 'dev-1', 'acme', 'x', '861')`);
    await owner.query(`INSERT INTO device_inventory (imei, tenant_id, state) VALUES ('MOTOR_001', 'motors', 'assigned')`);
    await owner.query(
      `INSERT INTO motor_upload_log (device_id, batch_id, first_seq, last_seq, record_count, stored_count, boot, lost_total, dropped_total)
       VALUES ('MOTOR_001', 'b-1', 1, 2, 2, 2, 1, 0, 0)`);
    try {
      await owner.runMigrations({ transaction: 'all' });
      expect(await owner.query(`SELECT tenant_id, code_type FROM fault_code_type_grant ORDER BY 1, 2`)).toEqual([
        { tenant_id: 'acme', code_type: 'vehicle-j1939' },
        { tenant_id: 'acme', code_type: 'vehicle-obd2' },
        { tenant_id: 'motors', code_type: 'motor-pump' },
      ]);
      expect(await owner.query(`SELECT 1 FROM dtc_master_catalog WHERE protocol = 'pcode'`)).toHaveLength(0);
      expect(await owner.query(`SELECT 1 FROM fault_code_motor`)).toHaveLength(6);
    } finally {
      await owner.query(`DELETE FROM motor_upload_log WHERE batch_id = 'b-1'`);
    }
  });
});
