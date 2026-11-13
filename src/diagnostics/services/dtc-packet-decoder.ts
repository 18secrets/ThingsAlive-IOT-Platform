import { DtcLamp, DtcProtocol } from '../entities/dtc-master.entity';
import { Severity } from '../../common/severity';

export interface DecodedDtc {
  protocol: DtcProtocol;
  code: string;
  spn?: number | null;
  fmi?: number | null;
  lampStatus: DtcLamp;
  severity: Severity;
  occurrenceCount?: number;
  description?: string;
}

export interface DecodedTelemetryPacket {
  imei: string;
  timestamp: Date;
  /** True if engine is running (e.g. RPM > 0 or ignition bit). Crucial for debounce key-off guard. */
  engineRunning?: boolean;
  dtcs: DecodedDtc[];
}

/**
 * Parses J1939 DM1 / DM2 and OBD-II trouble codes from raw frames or json payloads.
 */
export class DtcPacketDecoder {
  /**
   * Decodes a J1939 DM1 (PGN 65226) payload buffer according to SAE J1939-73.
   *
   * Byte 1-2: Lamp status
   * Bytes 3-6, 7-10...: 4-byte DTC blocks
   */
  static decodeJ1939Dm1(buffer: Buffer, imei: string, timestamp: Date, engineRunning = true): DecodedTelemetryPacket {
    if (buffer.length < 2) {
      return { imei, timestamp, engineRunning, dtcs: [] };
    }

    const lampByte1 = buffer.readUInt8(0);
    const protectLamp = (lampByte1 & 0x03) === 0x01;
    const amberWarning = ((lampByte1 >> 2) & 0x03) === 0x01;
    const redStop = ((lampByte1 >> 4) & 0x03) === 0x01;
    const mil = ((lampByte1 >> 6) & 0x03) === 0x01;

    let overallLamp: DtcLamp = 'none';
    if (redStop) overallLamp = 'red_stop';
    else if (protectLamp) overallLamp = 'protect';
    else if (amberWarning) overallLamp = 'amber_warning';
    else if (mil) overallLamp = 'mil';

    const dtcs: DecodedDtc[] = [];

    // Each DTC is 4 bytes starting at offset 2
    for (let offset = 2; offset + 4 <= buffer.length; offset += 4) {
      const b0 = buffer.readUInt8(offset);
      const b1 = buffer.readUInt8(offset + 1);
      const b2 = buffer.readUInt8(offset + 2);
      const b3 = buffer.readUInt8(offset + 3);

      const spn = b0 | (b1 << 8) | ((b2 >> 5) << 16);
      const fmi = b2 & 0x1f;
      const occurrenceCount = b3 & 0x7f;

      // SPN 0 or SPN 0x7FFFF means no active DTC
      if (spn === 0 || spn === 0x7ffff) {
        continue;
      }

      const code = `SPN:${spn}:FMI:${fmi}`;
      const severity: Severity = redStop || protectLamp ? 'critical' : (amberWarning ? 'high' : 'medium');

      dtcs.push({
        protocol: 'j1939',
        code,
        spn,
        fmi,
        lampStatus: overallLamp,
        severity,
        occurrenceCount,
      });
    }

    return {
      imei,
      timestamp,
      engineRunning,
      dtcs,
    };
  }

  /**
   * Decodes an OBD-II diagnostic payload or array of standard trouble codes.
   */
  static decodeObd2(codes: string[], imei: string, timestamp: Date, engineRunning = true): DecodedTelemetryPacket {
    const dtcs: DecodedDtc[] = [];

    for (const rawCode of codes) {
      const normalized = rawCode.trim().toUpperCase();
      if (!/^[PCBU][0-9A-F]{4}$/.test(normalized)) continue;

      // Critical powertrain misfires or safety codes
      const isCritical = /^P030[0-9]/.test(normalized) || /^P0217/.test(normalized) || /^P0524/.test(normalized);
      const lampStatus: DtcLamp = isCritical ? 'red_stop' : 'amber_warning';
      const severity: Severity = isCritical ? 'critical' : 'high';

      dtcs.push({
        protocol: 'obd2',
        code: normalized,
        lampStatus,
        severity,
      });
    }

    return {
      imei,
      timestamp,
      engineRunning,
      dtcs,
    };
  }

  /**
   * Generic decoder handling json payloads, raw hex buffers, or standard structured records.
   */
  static decodeGeneric(payload: unknown, imei: string, timestamp: Date, engineRunning = true): DecodedTelemetryPacket {
    if (!payload) {
      return { imei, timestamp, engineRunning, dtcs: [] };
    }

    if (Buffer.isBuffer(payload)) {
      return this.decodeJ1939Dm1(payload, imei, timestamp, engineRunning);
    }

    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return this.decodeGeneric(JSON.parse(trimmed), imei, timestamp, engineRunning);
        } catch {
          // fall through
        }
      }
      // Hex representation of J1939 packet
      if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 4) {
        return this.decodeJ1939Dm1(Buffer.from(trimmed, 'hex'), imei, timestamp, engineRunning);
      }
      // Single OBD code
      if (/^[PCBU][0-9A-F]{4}$/i.test(trimmed)) {
        return this.decodeObd2([trimmed], imei, timestamp, engineRunning);
      }
    }

    if (Array.isArray(payload)) {
      // Array of string codes e.g. ["P0115", "P0300"]
      if (payload.every((item) => typeof item === 'string')) {
        return this.decodeObd2(payload as string[], imei, timestamp, engineRunning);
      }
    }

    if (typeof payload === 'object') {
      const obj = payload as Record<string, any>;
      const isRunning = obj.engine_running !== undefined
        ? Boolean(obj.engine_running)
        : (obj.engine_rpm !== undefined ? Number(obj.engine_rpm) > 0 : engineRunning);

      const dtcs: DecodedDtc[] = [];

      // 1. Check for J1939 style list: faults / dtcs
      const faultList = obj.faults || obj.dtcs || obj.active_codes;
      if (Array.isArray(faultList)) {
        for (const item of faultList) {
          if (typeof item === 'string') {
            if (/^[PCBU][0-9A-F]{4}$/i.test(item)) {
              dtcs.push({
                protocol: 'obd2',
                code: item.toUpperCase(),
                lampStatus: 'amber_warning',
                severity: 'high',
              });
            } else if (item.startsWith('SPN:')) {
              const parts = item.split(':');
              const spn = Number(parts[1]);
              const fmi = parts[3] ? Number(parts[3]) : 0;
              dtcs.push({
                protocol: 'j1939',
                code: item,
                spn,
                fmi,
                lampStatus: 'amber_warning',
                severity: 'high',
              });
            }
          } else if (item && typeof item === 'object') {
            const spn = item.spn !== undefined ? Number(item.spn) : undefined;
            const fmi = item.fmi !== undefined ? Number(item.fmi) : undefined;
            const lamp: DtcLamp = item.lamp || (item.red_stop ? 'red_stop' : (item.amber ? 'amber_warning' : 'none'));
            const code = item.code || (spn !== undefined ? `SPN:${spn}:FMI:${fmi ?? 0}` : 'UNKNOWN');
            const severity: Severity = lamp === 'red_stop' || lamp === 'protect' ? 'critical' : (item.severity || 'high');

            dtcs.push({
              protocol: spn !== undefined ? 'j1939' : 'obd2',
              code,
              spn,
              fmi,
              lampStatus: lamp,
              severity,
              description: item.description,
            });
          }
        }
      }

      return {
        imei: obj.imei || imei,
        timestamp: obj.timestamp ? new Date(obj.timestamp) : timestamp,
        engineRunning: isRunning,
        dtcs,
      };
    }

    return { imei, timestamp, engineRunning, dtcs: [] };
  }
}
