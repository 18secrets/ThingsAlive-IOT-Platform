import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LEGACY_DATA_SOURCE } from './legacy-source';
import { DecodedTelemetryPacket, DtcPacketDecoder } from '../diagnostics/services/dtc-packet-decoder';

export interface PacketPullRequest {
  tenantId?: string;
  sourceSystem?: string;
  imeis: string[];
  from: Date;
  to?: Date;
  limit?: number;
}

export const MAX_PACKETS_PER_PULL = 10_000;

export interface LegacyPacketRow {
  id: number | string;
  imei: string;
  timestamp: Date;
  dtc_count?: number;
  dtc_data?: string | Buffer | null;
  dtc_errors?: unknown;
  packet_data?: unknown;
  engine_running?: boolean;
}

export interface DecodedDtcPacket extends DecodedTelemetryPacket {
  packetId: string;
}

/**
 * Reads raw diagnostic and telemetry packet frames from 1.0 `device_telemetry_packets`.
 *
 * Reads only, under read-only transaction guarantees. Filtered strictly to `dtc_count > 0`
 * as mandated by 2.0 DTC specifications.
 */
@Injectable()
export class LegacyPacketReader {
  private readonly logger = new Logger(LegacyPacketReader.name);

  constructor(
    @Optional() @Inject(LEGACY_DATA_SOURCE) private readonly legacy?: DataSource | null,
  ) {}

  get connected(): boolean {
    return !!this.legacy?.isInitialized;
  }

  async pullPackets(request: PacketPullRequest, schema = 'public'): Promise<DecodedDtcPacket[]> {
    if (!this.legacy?.isInitialized) return [];
    if (!request.imeis || request.imeis.length === 0) return [];

    const limit = request.limit ?? MAX_PACKETS_PER_PULL;

    try {
      // 1.0 device_telemetry_packets: query only packets where dtc_count > 0
      const rows: LegacyPacketRow[] = await this.legacy.query(
        `SELECT "id", "imei", "timestamp", "dtc_count", "dtc_data", "dtc_errors", "packet_data"
           FROM "${schema}"."device_telemetry_packets"
          WHERE "imei" = ANY($1::text[])
            AND "dtc_count" > 0
            AND "timestamp" > $2
            ${request.to ? 'AND "timestamp" <= $3' : ''}
          ORDER BY "timestamp" ASC
          LIMIT ${limit}`,
        request.to ? [request.imeis, request.from, request.to] : [request.imeis, request.from],
      );

      if (rows.length === limit) {
        this.logger.warn(`Packet pull hit limit of ${limit} records for ${request.imeis.length} devices`);
      }

      return rows.map((row) => {
        const ts = new Date(row.timestamp);
        // Prioritize decoded dtc_errors if present from 1.0, otherwise raw hex dtc_data, otherwise packet_data
        let decoded: DecodedTelemetryPacket;
        if (row.dtc_errors) {
          decoded = DtcPacketDecoder.decodeGeneric({ dtcs: row.dtc_errors, engine_running: row.engine_running }, row.imei, ts);
        } else if (row.dtc_data) {
          decoded = DtcPacketDecoder.decodeGeneric(row.dtc_data, row.imei, ts, row.engine_running ?? true);
        } else {
          decoded = DtcPacketDecoder.decodeGeneric(row.packet_data, row.imei, ts, row.engine_running ?? true);
        }

        return {
          ...decoded,
          packetId: String(row.id),
        };
      });
    } catch (err: any) {
      this.logger.error(`Failed to pull packets from 1.0 device_telemetry_packets: ${err.message}`, err.stack);
      return [];
    }
  }
}
