import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { RequestScope } from '../src/auth/types/request-scope';
import { DtcEpisodeService } from '../src/diagnostics/services/dtc-episode.service';
import { DtcSyncScheduler } from '../src/diagnostics/services/dtc-sync.scheduler';
import { DtcSyncService } from '../src/diagnostics/services/dtc-sync.service';
import { FaultCodeLibraryService } from '../src/diagnostics/services/fault-code-library.service';
import { COLUMNS, buildCodeTemplate, parseCodeWorkbook } from '../src/diagnostics/services/fault-code-workbook';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'VehicleCodesOwned1765600000000';

jest.setTimeout(60_000);

/**
 * Vehicle fault codes are 2.0's own (17 Nov 2026): 1.0 stops being their source, the
 * library is made here from the engine makers' sheets, and a code carries what those
 * sheets give a technician. Shown by doing it — editing a code 1.0 copied, importing a
 * maker's row, a machine sending a code with its fault type — and by trying what is still
 * forbidden: deleting a code, or reading P0425 as one of its fault types.
 */
describeDb('vehicle fault codes owned by 2.0, against the database', () => {
  let owner: DataSource;
  let ds: DataSource;
  let library: FaultCodeLibraryService;
  let faults: DtcEpisodeService;
  const master: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    library = new FaultCodeLibraryService(ds);
    faults = new DtcEpisodeService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "fault_code_type_grant", "device_dtc_episode" CASCADE`);
    // TRUNCATE, not DELETE: the table refuses deletes (dtc_master_owner_guard).
    await owner.query(`TRUNCATE "dtc_master_catalog", "fault_code_revision"`);
    await owner.query(`INSERT INTO "tenant" ("tenant_id", "name") VALUES ('acme', 'Acme') ON CONFLICT DO NOTHING`);
  });

  /** A row as 1.0's daily copy left it, before the copy stopped. */
  const from10 = async (code: string, spn: number | null = null, fmi: number | null = null, protocol = 'obd2') => {
    const [{ id }] = await owner.query(
      `INSERT INTO dtc_master_catalog (protocol, code, spn, fmi, description, source_system)
       VALUES ($1, $2, $3, $4, 'From 1.0', '1.0') RETURNING id`, [protocol, code, spn, fmi]);
    return id as string;
  };

  const sheet = async (type: keyof typeof COLUMNS, rows: Record<string, string | number>[]) => {
    const book = new Workbook();
    const s = book.addWorksheet('Codes');
    const fields = Object.keys(COLUMNS[type]);
    s.addRow(fields.map((f) => COLUMNS[type][f]));
    for (const r of rows) s.addRow(fields.map((f) => r[f] ?? ''));
    return Buffer.from(await book.xlsx.writeBuffer());
  };

  describe('a code 1.0 copied is edited here', () => {
    it('takes an edit, the makers\' fields and a retire, each in its history, and stays marked 1.0', async () => {
      const id = await from10('SPN:158:FMI:3', 158, 3, 'j1939');
      const edited = await library.update(master, 'vehicle-j1939', id, {
        description: 'Battery voltage above range', vehicleReaction: 'EGR switched off', sensor: 'Battery voltage (in ECU)',
      });
      expect(edited).toMatchObject({ description: 'Battery voltage above range', vehicleReaction: 'EGR switched off', source: '1.0' });
      await library.setRetired(master, 'vehicle-j1939', id, true);
      const fields = (await library.history('vehicle-j1939', id)).map((r) => r.field).sort();
      expect(fields).toEqual(['description', 'retired', 'sensor', 'vehicle_reaction']);
    });

    it('is still never deleted, and never changes hands, however it is written', async () => {
      const id = await from10('P0117');
      await expect(owner.query(`DELETE FROM dtc_master_catalog WHERE id = $1`, [id])).rejects.toThrow(/retired, not deleted/);
      await expect(owner.query(`UPDATE dtc_master_catalog SET source_system = '2.0' WHERE id = $1`, [id])).rejects.toThrow(/cannot change hands/);
    });

    it('is not written over by a daily copy: nothing schedules one', async () => {
      const sync = { runSync: jest.fn(), syncMasterCatalog: jest.fn() } as unknown as DtcSyncService;
      const scheduler = new DtcSyncScheduler(sync);
      const before = process.env.DTC_SYNC_ENABLED;
      process.env.DTC_SYNC_ENABLED = 'true';
      try {
        scheduler.onModuleInit();
        expect(sync.syncMasterCatalog).not.toHaveBeenCalled();
      } finally {
        scheduler.onModuleDestroy();
        if (before === undefined) delete process.env.DTC_SYNC_ENABLED; else process.env.DTC_SYNC_ENABLED = before;
      }
    });
  });

  describe('OBD-II codes with the ECU\'s fault type', () => {
    it('takes P0425-85 and P0119 as codes, and refuses a fault type that is not two hex digits', async () => {
      await expect(library.create(master, 'vehicle-obd2', { code: 'p0425-85', description: 'Temperature upstream of DOC too high' }))
        .resolves.toMatchObject({ code: 'P0425-85' });
      await expect(library.create(master, 'vehicle-obd2', { code: 'P0119', description: 'Coolant temperature signal not plausible' }))
        .resolves.toMatchObject({ code: 'P0119' });
      await expect(library.create(master, 'vehicle-obd2', { code: 'P0425-8', description: 'x' })).rejects.toThrow(BadRequestException);
    });

    describe('on the machine page', () => {
      const sent = (code: string) => owner.query(
        `INSERT INTO device_dtc_episode (tenant_id, source_system, external_id, imei, protocol, code, status, first_seen_at, last_seen_at)
         VALUES ('acme', 'iot-platform-1', 'EX-1', '861', 'obd2', $1, 'active', now(), now())`, [code]);
      const shown = async () => (await faults.getEquipmentFaults('acme', 'iot-platform-1', 'EX-1')).active[0];

      beforeEach(async () => { await library.grant(master, 'acme', 'vehicle-obd2'); });

      it('a code sent with its fault type reads its own entry first, with the makers\' fields', async () => {
        await library.create(master, 'vehicle-obd2', { code: 'P0119', description: 'Bare entry' });
        await library.create(master, 'vehicle-obd2', {
          code: 'P0119-00', description: 'Exact entry', troubleshooting: 'Step 1: check the battery voltage', pinDetails: 'Pin 1 & A28',
        });
        await sent('P0119-00');
        expect(await shown()).toMatchObject({ description: 'Exact entry', troubleshooting: 'Step 1: check the battery voltage', pinDetails: 'Pin 1 & A28' });
      });

      it('falls back to the bare code when the library lists only that', async () => {
        await library.create(master, 'vehicle-obd2', { code: 'P0119', description: 'Bare entry' });
        await sent('P0119-00');
        expect(await shown()).toMatchObject({ code: 'P0119-00', description: 'Bare entry' });
      });

      it('never reads a bare code sent as one of its fault types', async () => {
        await library.create(master, 'vehicle-obd2', { code: 'P0425-85', description: 'Too high' });
        await sent('P0425');
        expect(await shown()).toMatchObject({ code: 'P0425', description: 'P0425', troubleshooting: null });
      });
    });
  });

  describe('importing a maker\'s sheet', () => {
    it('the template carries the makers\' columns, and its example row reads as a valid code', async () => {
      const rows = await parseCodeWorkbook('vehicle-obd2', await buildCodeTemplate('vehicle-obd2'));
      expect(Object.keys(COLUMNS['vehicle-obd2'])).toEqual(expect.arrayContaining([
        'sensor', 'location', 'pinDetails', 'voltageRange', 'signalRange', 'diagnosticAids', 'troubleshooting', 'vehicleReaction',
      ]));
      const checked = await library.importCodes(master, 'vehicle-obd2', await sheet('vehicle-obd2', [rows[0].values]), false);
      expect(checked.rows[0]).toMatchObject({ code: 'P0117-00', status: 'new' });
    });

    it('adds new codes and changes one 1.0 copied, with every field, in one apply', async () => {
      await from10('P0117-00');
      const result = await library.importCodes(master, 'vehicle-obd2', await sheet('vehicle-obd2', [
        { code: 'P0117-00', description: 'Coolant temperature signal short to ground', vehicleReaction: 'Torque limited' },
        {
          code: 'P2200-86', description: 'NOx sensor upstream signal incorrect', sensor: 'NOx sensor', location: 'Exhaust, before SCR',
          diagnosticAids: 'Check the wiring harness', troubleshooting: 'Step 1\nCheck the wiring harness',
          voltageRange: '0.5-4.5 V', signalRange: '0-3000 ppm', pinDetails: 'Pin 1 & K66', severity: 'Critical', lamp: 'Amber warning',
        },
      ]), true);
      expect(result).toMatchObject({ applied: true, summary: { new: 1, changed: 1, errors: 0 } });
      const [nox] = await owner.query(`SELECT * FROM dtc_master_catalog WHERE code = 'P2200-86'`);
      expect(nox).toMatchObject({
        source_system: '2.0', sensor: 'NOx sensor', location: 'Exhaust, before SCR', voltage_range: '0.5-4.5 V',
        signal_range: '0-3000 ppm', pin_details: 'Pin 1 & K66', troubleshooting: 'Step 1\nCheck the wiring harness',
        severity: 'critical', lamp: 'amber_warning',
      });
      const [copied] = await owner.query(`SELECT * FROM dtc_master_catalog WHERE code = 'P0117-00'`);
      expect(copied).toMatchObject({ source_system: '1.0', vehicle_reaction: 'Torque limited' });
    });
  });

  it(`${MIGRATION} comes off and goes back on`, async () => {
    const id = await from10('P0117');
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'dtc_master_catalog' AND column_name = 'troubleshooting'`))
      .toHaveLength(0);
    // FaultCodeEditing's guard is back: a 1.0 row is the copy's alone.
    await expect(owner.query(`UPDATE dtc_master_catalog SET description = 'edited' WHERE id = $1`, [id])).rejects.toThrow(/is 1.0's/);
    await owner.runMigrations({ transaction: 'all' });
    await expect(owner.query(`UPDATE dtc_master_catalog SET description = 'edited' WHERE id = $1`, [id])).resolves.toBeDefined();
    await expect(owner.query(`DELETE FROM dtc_master_catalog WHERE id = $1`, [id])).rejects.toThrow(/retired, not deleted/);
  });
});
