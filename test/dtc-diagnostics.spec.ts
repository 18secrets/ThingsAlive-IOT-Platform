import { DtcPacketDecoder } from '../src/diagnostics/services/dtc-packet-decoder';
import { DtcEpisodeService, CONSECUTIVE_MISSING_THRESHOLD, ACTIVE_ABSENT_WINDOW_MS } from '../src/diagnostics/services/dtc-episode.service';
import { ALERT_TRIGGERS, evaluateRule, validateParams } from '../src/alert/services/alert-rules';
import { RULE_CLAUSES } from '../src/alert/services/alert-rule-render';
import { Severity } from '../src/common/severity';
import { RequestScope } from '../src/auth/types/request-scope';
import { createTestDataSource, describeDb } from './db';
import { DataSource } from 'typeorm';
import { withTenantSession, runTenantSpanning, APP_ROLE } from '../src/scope/tenant-session';

describe('DTC Diagnostics & Packet Ingestion', () => {
  describe('DtcPacketDecoder', () => {
    it('decodes J1939 DM1 buffer with Red Stop Lamp and SPN/FMI', () => {
      // Byte 0: 0x10 -> bits 4-5 = 01 (Red Stop Lamp active)
      // Byte 1: 0xFF
      // Bytes 2-5: SPN 100 (0x64), FMI 1 (0x01), occurrence count 5
      const buf = Buffer.from([0x10, 0xff, 0x64, 0x00, 0x01, 0x05]);
      const now = new Date('2026-11-12T10:00:00Z');
      const decoded = DtcPacketDecoder.decodeJ1939Dm1(buf, '862211074240870', now, true);

      expect(decoded.imei).toBe('862211074240870');
      expect(decoded.engineRunning).toBe(true);
      expect(decoded.dtcs).toHaveLength(1);

      const dtc = decoded.dtcs[0];
      expect(dtc.protocol).toBe('j1939');
      expect(dtc.code).toBe('SPN:100:FMI:1');
      expect(dtc.spn).toBe(100);
      expect(dtc.fmi).toBe(1);
      expect(dtc.lampStatus).toBe('red_stop');
      expect(dtc.severity).toBe(Severity.Critical);
      expect(dtc.occurrenceCount).toBe(5);
    });

    it('decodes Amber Warning Lamp in J1939 DM1', () => {
      // Byte 0: 0x04 -> bits 2-3 = 01 (Amber Warning Lamp active)
      // Bytes 2-5: SPN 110 (0x6E), FMI 0 (0x00), occurrence count 1
      const buf = Buffer.from([0x04, 0xff, 0x6e, 0x00, 0x00, 0x01]);
      const decoded = DtcPacketDecoder.decodeJ1939Dm1(buf, '862211074240870', new Date(), true);

      expect(decoded.dtcs).toHaveLength(1);
      const dtc = decoded.dtcs[0];
      expect(dtc.spn).toBe(110);
      expect(dtc.fmi).toBe(0);
      expect(dtc.lampStatus).toBe('amber_warning');
      expect(dtc.severity).toBe(Severity.High);
    });

    it('ignores SPN 0 (normal / no fault)', () => {
      const buf = Buffer.from([0x00, 0xff, 0x00, 0x00, 0x00, 0x00]);
      const decoded = DtcPacketDecoder.decodeJ1939Dm1(buf, '862211074240870', new Date(), true);
      expect(decoded.dtcs).toHaveLength(0);
    });

    it('decodes OBD-II standard trouble codes', () => {
      const decoded = DtcPacketDecoder.decodeObd2(['P0115', 'P0300'], '862211074240870', new Date(), true);
      expect(decoded.dtcs).toHaveLength(2);
      expect(decoded.dtcs[0].code).toBe('P0115');
      expect(decoded.dtcs[1].code).toBe('P0300');
      expect(decoded.dtcs[1].severity).toBe(Severity.Critical); // P0300 engine misfire is critical
    });

    it('decodes generic JSON payload with faults list and engine status', () => {
      const payload = {
        imei: '862211074240870',
        engine_rpm: 1500,
        faults: [
          { spn: 100, fmi: 1, lamp: 'red_stop', description: 'Low Oil Pressure' },
        ],
      };
      const decoded = DtcPacketDecoder.decodeGeneric(payload, 'fallback_imei', new Date());
      expect(decoded.engineRunning).toBe(true);
      expect(decoded.dtcs).toHaveLength(1);
      expect(decoded.dtcs[0].code).toBe('SPN:100:FMI:1');
      expect(decoded.dtcs[0].lampStatus).toBe('red_stop');
    });
  });

  describe('AlertTrigger coverage & rules (Phase 2 readiness)', () => {
    it('covers dtc trigger in ALERT_TRIGGERS and RULE_CLAUSES', () => {
      expect(ALERT_TRIGGERS).toContain('dtc');
      expect(typeof RULE_CLAUSES.dtc).toBe('function');

      const clauseSpn = RULE_CLAUSES.dtc({ spn: 100 }, () => ({ displayName: '' }));
      expect(clauseSpn).toContain('SPN 100 is active');

      const clauseCode = RULE_CLAUSES.dtc({ code: 'P0115' }, () => ({ displayName: '' }));
      expect(clauseCode).toContain('trouble code P0115 is active');

      const clauseLamp = RULE_CLAUSES.dtc({ lamp: 'red_stop' }, () => ({ displayName: '' }));
      expect(clauseLamp).toContain('red_stop');
    });

    it('validates DTC rule parameters', () => {
      expect(validateParams('dtc', { spn: 100 } as any)).toBeNull();
      expect(validateParams('dtc', { lamp: 'invalid_lamp' } as any)).toContain('DTC lamp must be one of');
    });

    it('evaluates DTC rule against active trouble codes in window', () => {
      const firing = evaluateRule({
        trigger: 'dtc',
        params: { spn: 100 },
        readings: [],
        predictions: [],
        dtcs: [
          { code: 'SPN:100:FMI:1', protocol: 'j1939', spn: 100, fmi: 1, lampStatus: 'red_stop', severity: Severity.Critical },
        ],
      });

      expect(firing).not.toBeNull();
      expect(firing?.summary).toContain('SPN:100:FMI:1');
      expect(firing?.evidence.spn).toBe(100);
    });

    it('does not fire when specified DTC is absent', () => {
      const firing = evaluateRule({
        trigger: 'dtc',
        params: { spn: 110 },
        readings: [],
        predictions: [],
        dtcs: [
          { code: 'SPN:100:FMI:1', protocol: 'j1939', spn: 100, fmi: 1, lampStatus: 'red_stop', severity: Severity.Critical },
        ],
      });

      expect(firing).toBeNull();
    });
  });

  describe('Debounce & 10-Minute Clearing Window', () => {
    it('clears code only after 10-minute absence window and consecutive missing threshold', async () => {
      const episodesStore = new Map<string, any>();

      const mockEntityManager: any = {
        query: jest.fn(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT * FROM "device_dtc_episode"')) {
            const externalId = params[2];
            return [...episodesStore.values()].filter(
              (ep) => ep.external_id === externalId && ep.status === 'active',
            );
          }
          if (sql.includes('INSERT INTO "device_dtc_episode"')) {
            const ep = {
              id: 'ep-1',
              tenant_id: params[0],
              source_system: params[1],
              external_id: params[2],
              imei: params[3],
              protocol: params[4],
              code: params[5],
              spn: params[6],
              fmi: params[7],
              lamp_status: params[8],
              severity: params[9],
              status: 'active',
              first_seen_at: params[10],
              last_seen_at: params[10],
              occurrences: 1,
              consecutive_missing_count: 0,
            };
            episodesStore.set(ep.code, ep);
            return [ep];
          }
          if (sql.includes('UPDATE "device_dtc_episode"')) {
            if (sql.includes("status' = 'cleared'") || sql.includes('"status" = \'cleared\'')) {
              const ep = episodesStore.get('SPN:100:FMI:1');
              if (ep) {
                ep.status = 'cleared';
                ep.cleared_at = params[0];
                ep.consecutive_missing_count = params[1];
              }
              return [ep];
            }
            if (sql.includes('consecutive_missing_count')) {
              const ep = episodesStore.get('SPN:100:FMI:1');
              if (ep) ep.consecutive_missing_count = params[0];
              return [ep];
            }
          }
          return [];
        }),
      };

      const mockDs: any = {
        transaction: jest.fn(async (fn: any) => fn(mockEntityManager)),
        query: mockEntityManager.query,
      };

      const service = new DtcEpisodeService(mockDs);

      // Packet 1: Fault arrives at 10:00:00 -> becomes active
      const t1 = new Date('2026-11-13T10:00:00Z');
      const p1 = {
        imei: '862211074240870',
        timestamp: t1,
        engineRunning: true,
        dtcs: [{ protocol: 'j1939' as const, code: 'SPN:100:FMI:1', spn: 100, fmi: 1, lampStatus: 'amber_warning' as const, severity: Severity.High }],
      };

      await service.processPacket('tenant-1', 'BEML-EX-01', p1, '1.0');
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('active');
      expect(episodesStore.get('SPN:100:FMI:1').consecutive_missing_count).toBe(0);

      // Packet 2: Code absent 2 minutes later -> STILL active (10 minutes haven't passed)
      const t2 = new Date('2026-11-13T10:02:00Z');
      const p2 = {
        imei: '862211074240870',
        timestamp: t2,
        engineRunning: true,
        dtcs: [],
      };
      await service.processPacket('tenant-1', 'BEML-EX-01', p2, '1.0');
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('active');
      expect(episodesStore.get('SPN:100:FMI:1').consecutive_missing_count).toBe(1);

      // Packet 3: Code absent 5 minutes later -> STILL active
      const t3 = new Date('2026-11-13T10:05:00Z');
      const p3 = {
        imei: '862211074240870',
        timestamp: t3,
        engineRunning: true,
        dtcs: [],
      };
      await service.processPacket('tenant-1', 'BEML-EX-01', p3, '1.0');
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('active');
      expect(episodesStore.get('SPN:100:FMI:1').consecutive_missing_count).toBe(2);

      // Packet 4: Code absent 11 minutes later (> ACTIVE_ABSENT_WINDOW_MS and >= 3 missing count) -> CLEARED!
      const t4 = new Date('2026-11-13T10:11:00Z');
      const p4 = {
        imei: '862211074240870',
        timestamp: t4,
        engineRunning: true,
        dtcs: [],
      };
      await service.processPacket('tenant-1', 'BEML-EX-01', p4, '1.0');
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('cleared');
    });

    it('preserves active fault when engine is off (key-off guard)', async () => {
      const episodesStore = new Map<string, any>([
        ['SPN:100:FMI:1', {
          id: 'ep-1',
          external_id: 'BEML-EX-01',
          code: 'SPN:100:FMI:1',
          status: 'active',
          consecutive_missing_count: 0,
          last_seen_at: new Date('2026-11-13T10:00:00Z'),
        }],
      ]);

      const mockEntityManager: any = {
        query: jest.fn(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT * FROM "device_dtc_episode"')) {
            return [...episodesStore.values()];
          }
          return [];
        }),
      };

      const mockDs: any = {
        transaction: jest.fn(async (fn: any) => fn(mockEntityManager)),
      };

      const service = new DtcEpisodeService(mockDs);

      // Packet arrives with engineRunning: false (engine keyed off) even after 20 minutes
      const packetEngineOff = {
        imei: '862211074240870',
        timestamp: new Date('2026-11-13T10:20:00Z'),
        engineRunning: false,
        dtcs: [],
      };

      await service.processPacket('tenant-1', 'BEML-EX-01', packetEngineOff, '1.0');

      // Episode must remain ACTIVE and consecutive_missing_count should NOT increment
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('active');
      expect(episodesStore.get('SPN:100:FMI:1').consecutive_missing_count).toBe(0);
    });
  });

  describe('Route 4: GET /equipment/:sourceSystem/:externalId/faults', () => {
    const scope: RequestScope = {
      tenantId: 'tenant-1',
      userId: 'u-1',
      roles: ['admin'],
      isPlatformRole: false,
    };

    it('returns reportsFaults: false and empty arrays when device has never sent DTC field', async () => {
      const mockDs: any = {
        transaction: jest.fn(async (fn: any) => fn(mockDs)),
        query: jest.fn(async (sql: string) => {
          if (sql.includes('EXISTS')) {
            return [{ has_episodes: false, has_watermark: false }];
          }
          return [];
        }),
      };

      const service = new DtcEpisodeService(mockDs);
      const res = await service.getEquipmentFaults(scope, '1.0', 'SIMPLE-PUMP-01');

      expect(res.reportsFaults).toBe(false);
      expect(res.active).toEqual([]);
      expect(res.history).toEqual([]);
    });

    it('returns reportsFaults: true, active list, and history with description and remedies', async () => {
      const mockDs: any = {
        transaction: jest.fn(async (fn: any) => fn(mockDs)),
        query: jest.fn(async (sql: string) => {
          if (sql.includes('EXISTS')) {
            return [{ has_episodes: true, has_watermark: true }];
          }
          if (sql.includes('FROM "device_dtc_episode" e')) {
            return [
              {
                id: 'ep-active-1',
                code: 'SPN:100:FMI:1',
                protocol: 'j1939',
                spn: 100,
                fmi: 1,
                lamp: 'red_stop',
                severity: Severity.Critical,
                status: 'active',
                firstSeenAt: new Date('2026-11-13T09:00:00Z'),
                lastSeenAt: new Date('2026-11-13T10:00:00Z'),
                clearedAt: null,
                occurrences: 4,
                description: 'Engine Oil Pressure Extremely Low',
                causes: 'Clogged oil filter, oil level low',
                remedies: 'Check dipstick, replace oil filter',
              },
              {
                id: 'ep-cleared-1',
                code: 'SPN:110:FMI:0',
                protocol: 'j1939',
                spn: 110,
                fmi: 0,
                lamp: 'amber_warning',
                severity: Severity.High,
                status: 'cleared',
                firstSeenAt: new Date('2026-11-13T07:00:00Z'),
                lastSeenAt: new Date('2026-11-13T08:00:00Z'),
                clearedAt: new Date('2026-11-13T08:15:00Z'),
                occurrences: 1,
                description: 'Engine Coolant High Temperature',
                causes: 'Coolant leak, radiator fan malfunction',
                remedies: 'Inspect coolant level, check radiator fan',
              },
            ];
          }
          return [];
        }),
      };

      const service = new DtcEpisodeService(mockDs);
      const res = await service.getEquipmentFaults(scope, '1.0', 'BEML-EX-01');

      expect(res.reportsFaults).toBe(true);
      expect(res.active).toHaveLength(1);
      expect(res.active[0].code).toBe('SPN:100:FMI:1');
      expect(res.active[0].lamp).toBe('red_stop');
      expect(res.active[0].description).toBe('Engine Oil Pressure Extremely Low');
      expect(res.active[0].remedies).toContain('replace oil filter');

      expect(res.history).toHaveLength(1);
      expect(res.history[0].code).toBe('SPN:110:FMI:0');
      expect(res.history[0].clearedAt).toBeDefined();
    });
  });

  describeDb('Database integration & Row-Level Security', () => {
    let ds: DataSource;

    beforeAll(async () => {
      ds = await createTestDataSource();
      await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
      await ds.runMigrations({ transaction: 'all' });
    }, 30_000);

    afterAll(async () => {
      await ds?.destroy();
    });

    it('enforces tenant isolation and prevents cross-account code reads', async () => {
      const scopeA: RequestScope = { tenantId: 'tenant-a', userId: 'u-a', roles: ['admin'], isPlatformRole: false };
      const scopeB: RequestScope = { tenantId: 'tenant-b', userId: 'u-b', roles: ['admin'], isPlatformRole: false };

      const service = new DtcEpisodeService(ds);

      // Ingest fault for tenant-a machine
      const packet = {
        imei: '862211074240870',
        timestamp: new Date('2026-11-13T10:00:00Z'),
        engineRunning: true,
        dtcs: [{ protocol: 'j1939' as const, code: 'SPN:100:FMI:1', spn: 100, fmi: 1, lampStatus: 'red_stop' as const, severity: Severity.Critical }],
      };

      await service.processPacket('tenant-a', 'MACHINE-A', packet, '1.0');

      // Tenant A queries its machine faults -> returns fault
      const resA = await service.getEquipmentFaults(scopeA, '1.0', 'MACHINE-A');
      expect(resA.reportsFaults).toBe(true);
      expect(resA.active).toHaveLength(1);
      expect(resA.active[0].code).toBe('SPN:100:FMI:1');

      // Tenant B queries the same machine -> RLS evaluates to false, returns 0 active faults
      const resB = await service.getEquipmentFaults(scopeB, '1.0', 'MACHINE-A');
      expect(resB.reportsFaults).toBe(false);
      expect(resB.active).toHaveLength(0);
    });

    it('enforces partial unique index against duplicate active episodes', async () => {
      const service = new DtcEpisodeService(ds);

      const packet1 = {
        imei: '862211074240871',
        timestamp: new Date('2026-11-13T10:00:00Z'),
        engineRunning: true,
        dtcs: [{ protocol: 'j1939' as const, code: 'SPN:110:FMI:0', spn: 110, fmi: 0, lampStatus: 'amber_warning' as const, severity: Severity.High }],
      };

      // Ingest packet 1
      await service.processPacket('tenant-a', 'MACHINE-X', packet1, '1.0');

      // Ingest packet 2 with the same active DTC 5 seconds later
      const packet2 = {
        imei: '862211074240871',
        timestamp: new Date('2026-11-13T10:00:05Z'),
        engineRunning: true,
        dtcs: [{ protocol: 'j1939' as const, code: 'SPN:110:FMI:0', spn: 110, fmi: 0, lampStatus: 'amber_warning' as const, severity: Severity.High }],
      };
      await service.processPacket('tenant-a', 'MACHINE-X', packet2, '1.0');

      // Verify that there is exactly ONE active episode with occurrences = 2
      await runTenantSpanning(ds, 'verify-count', async (m) => {
        const rows = await m.query(
          `SELECT occurrences FROM "device_dtc_episode"
            WHERE "tenant_id" = 'tenant-a' AND "external_id" = 'MACHINE-X' AND "code" = 'SPN:110:FMI:0' AND "status" = 'active'`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].occurrences).toBe(2);
      });
    });
  });
});
