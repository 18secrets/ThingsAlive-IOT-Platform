import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { AlertService } from '../src/alert/services/alert.service';
import { DtcEpisodeService } from '../src/diagnostics/services/dtc-episode.service';
import { DtcSyncService } from '../src/diagnostics/services/dtc-sync.service';
import { LegacyDtcMasterReader } from '../src/legacy/legacy-dtc-master.reader';
import { LegacyPacketReader } from '../src/legacy/legacy-packet.reader';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'DtcActiveUnique1764800000000';
const SS = 'iot-platform-1';
const IMEI = '861000000000001';

jest.setTimeout(30_000);

/**
 * Fault codes end to end against Postgres (the DTC plan, phase 1). The first cut's spec
 * ran its service on a mocked DataSource, which is how a service that could save nothing
 * under row security, a pull that asked 1.0 for columns it does not have, and a code that
 * could never clear all passed. Here 1.0's two tables stand in the test database under
 * 1.0's own column names, read through the owner connection as the legacy one would; 2.0
 * runs as the application role, so its row security is the real one.
 */
describeDb('fault codes (DTC) against the database', () => {
  let owner: DataSource;
  let ds: DataSource;
  let episodes: DtcEpisodeService;
  let sync: DtcSyncService;
  let master: LegacyDtcMasterReader;
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    // 1.0, as its receiver and its entity define the two tables 2.0 reads.
    await owner.query(`
      CREATE TABLE "device_telemetry_packets" (
        "id" bigserial PRIMARY KEY, "imei_number" varchar(50), "packet_timestamp" timestamptz,
        "engine_running_status" integer, "dtc_count" integer NOT NULL DEFAULT 0,
        "dtc_errors" jsonb NOT NULL DEFAULT '[]'::jsonb)`);
    await owner.query(`
      CREATE TABLE "dtc_master" (
        "id" serial PRIMARY KEY, "source_type" text, "dtc_code" text, "p_code" text, "spn" text, "fmi" text,
        "description" text, "description_simp" text, "category" text, "lamp" text, "causes" text, "remedies" text)`);
    ds = await createAppDataSource();
    episodes = new DtcEpisodeService(ds);
    master = new LegacyDtcMasterReader(owner);
    sync = new DtcSyncService(ds, new LegacyPacketReader(owner), master, episodes, new AlertService(ds));
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE "device_dtc_episode", "dtc_pull_watermark", "dtc_master_catalog", "alert_event", "alert_rule",
      "device_projection", "device_telemetry_packets", "dtc_master" RESTART IDENTITY CASCADE`);
    // A machine reaches its device the way the fleet sync records it: the device is
    // `dev-EX-01`, fitted to machine `EX-01`.
    await owner.query(
      `INSERT INTO "device_projection" (source_system, external_id, tenant_id, checksum, imei, equipment_external_id)
       VALUES ($1, 'dev-EX-01', 'acme', 'x', $2, 'EX-01')`, [SS, IMEI],
    );
    await owner.query(
      `INSERT INTO "dtc_master" (source_type, spn, fmi, description, lamp, causes, remedies)
       VALUES ('ACU', '177', '16', 'Transmission oil temperature high', 'Red Stop', 'Cooler blocked', 'Clean the cooler')`,
    );
    await master.syncMasterCatalog(ds);
  });

  const packet = (at: string, errors: { spn: number; fmi: number }[], running = 1) => owner.query(
    `INSERT INTO "device_telemetry_packets" (imei_number, packet_timestamp, engine_running_status, dtc_count, dtc_errors)
     VALUES ($1, $2, $3, $4, $5::jsonb)`, [IMEI, at, running, errors.length, JSON.stringify(errors)],
  );
  const NOW = new Date('2026-11-13T10:30:00Z');

  it('a coded packet opens a fault the machine page reads, with its meaning from 1.0', async () => {
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    const result = await sync.runSync(NOW);
    expect(result).toMatchObject({ devicesPolled: 1, packetsIngested: 1 });

    const faults = await episodes.getEquipmentFaults('acme', SS, 'EX-01');
    expect(faults.reportsFaults).toBe(true);
    expect(faults.active).toEqual([expect.objectContaining({
      code: 'SPN:177:FMI:16', spn: 177, fmi: 16, lamp: 'red_stop', severity: 'critical',
      description: 'Transmission oil temperature high', causes: 'Cooler blocked', remedies: 'Clean the cooler',
    })]);
  });

  it('another account sees nothing of it', async () => {
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    await sync.runSync(NOW);
    expect(await episodes.getEquipmentFaults('globex', SS, 'EX-01')).toEqual({ reportsFaults: false, active: [], history: [] });
    expect(await episodes.getActiveEpisodes('globex', 'EX-01')).toEqual([]);
  });

  it('a machine whose device never sent a code shows no panel', async () => {
    expect(await episodes.getEquipmentFaults('acme', SS, 'EX-01')).toEqual({ reportsFaults: false, active: [], history: [] });
  });

  it('clears once the machine has run ten minutes without the code — though no coded packet says so', async () => {
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    await sync.runSync(new Date('2026-11-13T10:01:00Z'));
    // Codeless packets only: the pull never reads these, and the code must still clear.
    await packet('2026-11-13T10:05:00Z', []);
    await sync.runSync(new Date('2026-11-13T10:06:00Z'));
    expect((await episodes.getEquipmentFaults('acme', SS, 'EX-01')).active).toHaveLength(1);

    await packet('2026-11-13T10:11:00Z', []);
    const result = await sync.runSync(new Date('2026-11-13T10:12:00Z'));
    expect(result.cleared).toBe(1);
    const faults = await episodes.getEquipmentFaults('acme', SS, 'EX-01');
    expect(faults.active).toEqual([]);
    expect(faults.history).toEqual([expect.objectContaining({ code: 'SPN:177:FMI:16', clearedAt: '2026-11-13T10:11:00.000Z' })]);
  });

  it('a stopped engine clears nothing', async () => {
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    await packet('2026-11-13T10:20:00Z', [], 0);
    await sync.runSync(NOW);
    expect((await episodes.getEquipmentFaults('acme', SS, 'EX-01')).active).toHaveLength(1);
  });

  it('two passes fired together: one runs, one stands aside, the fault is opened once', async () => {
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    const results = await Promise.allSettled([sync.runSync(NOW), sync.runSync(NOW)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(Number((await owner.query(`SELECT count(*) AS n FROM "device_dtc_episode"`))[0].n)).toBe(1);
  });

  it('the same code processed twice at once is one active episode, not two', async () => {
    const p = { imei: IMEI, timestamp: new Date('2026-11-13T10:00:00Z'), engineRunning: true,
      dtcs: [{ protocol: 'j1939' as const, code: 'SPN:177:FMI:16', spn: 177, fmi: 16, lampStatus: 'none' as const, severity: 'high' as never }] };
    const results = await Promise.allSettled([episodes.processPacket('acme', 'EX-01', p, SS), episodes.processPacket('acme', 'EX-01', p, SS)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await owner.query(`SELECT occurrences FROM "device_dtc_episode" WHERE status = 'active'`)).toEqual([{ occurrences: 2 }]);
  });

  it('the database refuses a second active episode of one code, whoever writes it', async () => {
    const row = `('acme', '${SS}', 'EX-01', '${IMEI}', 'j1939', 'SPN:177:FMI:16', 'active', now(), now())`;
    const insert = `INSERT INTO "device_dtc_episode" (tenant_id, source_system, external_id, imei, protocol, code, status, first_seen_at, last_seen_at) VALUES ${row}`;
    await owner.query(insert);
    await expect(owner.query(insert)).rejects.toThrow(/uq_device_dtc_episode_one_active/);
  });

  it('a fault-code alert rule fires when the code opens', async () => {
    await new AlertService(ds).createRule(acme, {
      slug: 'red-lamp', name: 'Red stop lamp', trigger: 'dtc', params: { lamp: 'red_stop' } as never,
    });
    await packet('2026-11-13T10:00:00Z', [{ spn: 177, fmi: 16 }]);
    const result = await sync.runSync(NOW);
    expect(result.alertsRaised).toBe(1);
    expect(await owner.query(`SELECT rule_name FROM "alert_event"`)).toEqual([{ rule_name: 'Red stop lamp' }]);
  });

  it('DtcAlertTrigger1764900000000 comes off and goes back on', async () => {
    await undoMigrationNamed(owner, 'DtcAlertTrigger1764900000000');
    const def = async () => (await owner.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck_alert_rule_trigger'`))[0].d as string;
    expect(await def()).not.toMatch(/'dtc'/);
    await owner.runMigrations({ transaction: 'all' });
    expect(await def()).toMatch(/'dtc'/);
  });

  it(`${MIGRATION} comes off and goes back on`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    expect(await owner.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_device_dtc_episode_one_active'`)).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_device_dtc_episode_one_active'`)).toHaveLength(1);
  });
});
