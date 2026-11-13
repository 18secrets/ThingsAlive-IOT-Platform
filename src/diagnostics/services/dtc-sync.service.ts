import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LegacyPacketReader } from '../../legacy/legacy-packet.reader';
import { LegacyDtcMasterReader } from '../../legacy/legacy-dtc-master.reader';
import { DtcEpisodeService } from './dtc-episode.service';
import { tryTakePassLock } from '../../shift/services/pass-lock';

export const DTC_PULL_LOCK_KEY = 8_742_310_002;
export const DEFAULT_LOOKBACK_HOURS = 24;

export interface DtcSyncResult {
  locked: boolean;
  devicesPolled: number;
  packetsIngested: number;
  masterCodesSynced?: number;
}

/**
 * Scheduled pull service for 1.0 DTC telemetry and master catalog mirroring.
 *
 * Guarantees:
 * 1. Read-only on 1.0 (device_telemetry_packets and dtc_master).
 * 2. Concurrency-safe: Postgres advisory lock guarantees two pulls fired together never clash.
 * 3. Watermarked: Resumes from last pulled position after process restart.
 * 4. Filters only packets with dtc_count > 0.
 */
@Injectable()
export class DtcSyncService {
  private readonly logger = new Logger(DtcSyncService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly packetReader: LegacyPacketReader,
    private readonly masterReader: LegacyDtcMasterReader,
    private readonly episodeService: DtcEpisodeService,
  ) {}

  /**
   * Runs a DTC telemetry pull cycle for known active devices.
   */
  async runSync(now = new Date()): Promise<DtcSyncResult> {
    const lock = await tryTakePassLock(this.ds, DTC_PULL_LOCK_KEY);
    if (!lock) {
      this.logger.log('DTC pull already in progress on another worker. Skipping concurrent pass.');
      return { locked: true, devicesPolled: 0, packetsIngested: 0 };
    }

    try {
      // 1. Discover all distinct IMEIs known to 2.0 with their tenant & equipment mapping
      const knownDevices: Array<{ tenant_id: string; source_system: string; external_id: string; imei: string }> =
        await this.ds.query(
          `SELECT DISTINCT s.tenant_id, s.source_system, s.external_id, s.imei
             FROM "sensor_map_projection" s
            WHERE s.imei IS NOT NULL AND s.imei <> ''`,
        );

      if (knownDevices.length === 0) {
        return { locked: false, devicesPolled: 0, packetsIngested: 0 };
      }

      // Group devices by IMEI
      const imeiMap = new Map<string, { tenantId: string; sourceSystem: string; externalId: string }>();
      for (const d of knownDevices) {
        imeiMap.set(d.imei, {
          tenantId: d.tenant_id,
          sourceSystem: d.source_system,
          externalId: d.external_id,
        });
      }

      const imeis = Array.from(imeiMap.keys());

      // 2. Load watermarks per IMEI
      const watermarks: Array<{ imei: string; last_packet_time: Date; last_packet_id: string | null }> =
        await this.ds.query(
          `SELECT "imei", "last_packet_time", "last_packet_id"
             FROM "dtc_pull_watermark"
            WHERE "imei" = ANY($1::text[])`,
          [imeis],
        );

      const watermarkMap = new Map<string, Date>(
        watermarks.map((w) => [w.imei, new Date(w.last_packet_time)]),
      );

      const fallbackFrom = new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 3600_000);
      let totalPackets = 0;

      // 3. Pull packets per device / batch
      // Pull each imei from its specific watermark
      for (const imei of imeis) {
        const from = watermarkMap.get(imei) ?? fallbackFrom;
        const target = imeiMap.get(imei)!;

        const packets = await this.packetReader.pullPackets({
          tenantId: target.tenantId,
          sourceSystem: target.sourceSystem,
          imeis: [imei],
          from,
          to: now,
          limit: 1000,
        });

        if (packets.length === 0) continue;

        let newestTime = from;
        let newestPacketId: string | null = null;

        for (const packet of packets) {
          await this.episodeService.processPacket(
            target.tenantId,
            target.externalId,
            packet,
            target.sourceSystem,
          );

          if (packet.timestamp > newestTime) {
            newestTime = packet.timestamp;
            newestPacketId = packet.packetId;
          }
          totalPackets++;
        }

        // Upsert watermark
        await this.ds.query(
          `INSERT INTO "dtc_pull_watermark" ("imei", "last_packet_id", "last_packet_time", "updated_at")
           VALUES ($1, $2, $3, now())
           ON CONFLICT ("imei")
           DO UPDATE SET "last_packet_id" = EXCLUDED."last_packet_id",
                         "last_packet_time" = EXCLUDED."last_packet_time",
                         "updated_at" = now()`,
          [imei, newestPacketId, newestTime],
        );
      }

      return {
        locked: false,
        devicesPolled: imeis.length,
        packetsIngested: totalPackets,
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * Daily mirroring of 1.0 dtc_master into 2.0 dtc_master_catalog.
   */
  async syncMasterCatalog(schema = 'public'): Promise<number> {
    const synced = await this.masterReader.syncMasterCatalog(this.ds, schema);
    this.logger.log(`Mirrored ${synced} DTC definitions from 1.0 master catalog.`);
    return synced;
  }
}
