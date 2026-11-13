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

/** A row of 1.0's `device_telemetry_packets`, under the column names 1.0's own receiver
 * writes (`beml_data_receive_packet_modified.py`): `imei_number`, `packet_timestamp`,
 * `engine_running_status`; `dtc_errors` is `[{"spn": 177, "fmi": 16}, …]`. */
export interface LegacyPacketRow {
  id: number | string;
  imei: string;
  ts: Date;
  dtc_count?: number;
  dtc_errors?: unknown;
  engine_running_status?: number | null;
}

/** The newest packet each device sent with its engine running, codes or not. */
export interface LatestRunningPacket {
  imei: string;
  at: Date;
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

  /**
   * Packets that carry codes (`dtc_count > 0`), oldest first, after `from`.
   *
   * Under 1.0's real column names: the first cut asked for `imei`, `timestamp` and
   * `packet_data`, which that table does not have, so every pull failed, was caught, and
   * returned nothing without a word beyond a log line. A failure now throws: an empty
   * pull and a broken one must not look the same.
   */
  async pullPackets(request: PacketPullRequest, schema = 'public'): Promise<DecodedDtcPacket[]> {
    if (!this.legacy?.isInitialized) return [];
    if (!request.imeis || request.imeis.length === 0) return [];
    const limit = request.limit ?? MAX_PACKETS_PER_PULL;
    const rows: LegacyPacketRow[] = await this.legacy.query(
      `SELECT "id", "imei_number" AS "imei", "packet_timestamp" AS "ts",
              "dtc_count", "dtc_errors", "engine_running_status"
         FROM "${schema}"."device_telemetry_packets"
        WHERE "imei_number" = ANY($1::text[])
          AND "dtc_count" > 0
          AND "packet_timestamp" > $2
          ${request.to ? 'AND "packet_timestamp" <= $3' : ''}
        ORDER BY "packet_timestamp" ASC
        LIMIT ${limit}`,
      request.to ? [request.imeis, request.from, request.to] : [request.imeis, request.from],
    );
    if (rows.length === limit) {
      this.logger.warn(`Packet pull hit limit of ${limit} records for ${request.imeis.length} devices`);
    }
    return rows.map((row) => {
      const ts = new Date(row.ts);
      // 1.0 stores engine_running_status as 0/1; null means it did not say.
      const running = row.engine_running_status == null ? true : Number(row.engine_running_status) !== 0;
      const decoded = DtcPacketDecoder.decodeGeneric({ dtcs: row.dtc_errors ?? [], engine_running: running }, row.imei, ts, running);
      return { ...decoded, imei: row.imei, timestamp: ts, packetId: String(row.id) };
    });
  }

  /**
   * Each device's newest packet with the engine running, whether it carried codes or not.
   *
   * The pull above reads only packets with codes, so once a machine's codes all go away
   * its packets are never read again, and its last codes would stay "active" for ever.
   * This is how the sync learns the machine has been running without them.
   */
  async latestRunningPackets(imeis: string[], since: Date, schema = 'public'): Promise<LatestRunningPacket[]> {
    if (!this.legacy?.isInitialized || imeis.length === 0) return [];
    const rows: { imei: string; at: Date }[] = await this.legacy.query(
      `SELECT "imei_number" AS "imei", max("packet_timestamp") AS "at"
         FROM "${schema}"."device_telemetry_packets"
        WHERE "imei_number" = ANY($1::text[])
          AND "packet_timestamp" > $2
          AND COALESCE("engine_running_status", 1) <> 0
        GROUP BY "imei_number"`,
      [imeis, since],
    );
    return rows.filter((r) => r.at).map((r) => ({ imei: r.imei, at: new Date(r.at) }));
  }
}
