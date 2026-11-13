import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LEGACY_DATA_SOURCE } from './legacy-source';
import { DecodedTelemetryPacket, DtcPacketDecoder } from '../diagnostics/services/dtc-packet-decoder';

export interface PacketPullRequest {
  tenantId: string;
  sourceSystem: string;
  imeis: string[];
  from: Date;
  to: Date;
}

export const MAX_PACKETS_PER_PULL = 10_000;

export interface LegacyPacketRow {
  id: number | string;
  imei: string;
  timestamp: Date;
  packet_data: unknown;
  engine_running?: boolean;
}

/**
 * Reads raw diagnostic and telemetry packet frames from 1.0 `device_telemetry_packets`.
 *
 * Reads only, under read-only transaction guarantees.
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

  async pullPackets(request: PacketPullRequest, schema = 'public'): Promise<DecodedTelemetryPacket[]> {
    if (!this.legacy?.isInitialized) return [];
    if (!request.imeis || request.imeis.length === 0) return [];

    try {
      const rows: LegacyPacketRow[] = await this.legacy.query(
        `SELECT "id", "imei", "timestamp", "packet_data"
           FROM "${schema}"."device_telemetry_packets"
          WHERE "imei" = ANY($1::text[])
            AND "timestamp" > $2
            AND "timestamp" <= $3
          ORDER BY "timestamp" ASC
          LIMIT ${MAX_PACKETS_PER_PULL}`,
        [request.imeis, request.from, request.to],
      );

      if (rows.length === MAX_PACKETS_PER_PULL) {
        this.logger.warn(`Packet pull hit limit of ${MAX_PACKETS_PER_PULL} records for tenant ${request.tenantId}`);
      }

      return rows.map((row) =>
        DtcPacketDecoder.decodeGeneric(
          row.packet_data,
          row.imei,
          new Date(row.timestamp),
          row.engine_running ?? true,
        ),
      );
    } catch (err: any) {
      // If table does not exist or column differences exist, log error cleanly
      this.logger.error(`Failed to pull packets from 1.0 device_telemetry_packets: ${err.message}`, err.stack);
      return [];
    }
  }
}
