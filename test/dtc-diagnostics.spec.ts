import { DtcPacketDecoder } from '../src/diagnostics/services/dtc-packet-decoder';
import { DtcEpisodeService, CONSECUTIVE_MISSING_THRESHOLD, ACTIVE_ABSENT_WINDOW_MS } from '../src/diagnostics/services/dtc-episode.service';
import { ALERT_TRIGGERS, evaluateRule, validateParams } from '../src/alert/services/alert-rules';
import { RULE_CLAUSES } from '../src/alert/services/alert-rule-render';
import { Severity } from '../src/common/severity';

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
      expect(dtc.severity).toBe('critical');
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
      expect(dtc.severity).toBe('high');
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
      expect(decoded.dtcs[1].severity).toBe('critical'); // P0300 engine misfire is critical
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
    // The 10-minute clearing and the faults route are tested on Postgres, as the service now
    // runs every query in a tenant session: test/dtc-faults-db.spec.ts.
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

      await service.processPacket('tenant-1', 'BEML-EX-01', packetEngineOff);

      // Episode must remain ACTIVE and consecutive_missing_count should NOT increment
      expect(episodesStore.get('SPN:100:FMI:1').status).toBe('active');
      expect(episodesStore.get('SPN:100:FMI:1').consecutive_missing_count).toBe(0);
    });
  });
});
