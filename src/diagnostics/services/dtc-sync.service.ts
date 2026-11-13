import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LegacyPacketReader } from '../../legacy/legacy-packet.reader';
import { LegacyDtcMasterReader } from '../../legacy/legacy-dtc-master.reader';
import { DtcEpisodeService } from './dtc-episode.service';
import { tryTakePassLock } from '../../shift/services/pass-lock';
import { runTenantSpanning } from '../../scope/tenant-session';
import { AlertService } from '../../alert/services/alert.service';

export const DTC_PULL_LOCK_KEY = 8_742_310_002;
export const DEFAULT_LOOKBACK_HOURS = 24;

export interface DtcSyncResult {
  locked: boolean;
  devicesPolled: number;
  packetsIngested: number;
  /** Episodes cleared because the machine ran ten minutes without the code. */
  cleared?: number;
  /** Fault-code alerts raised this pass. */
  alertsRaised?: number;
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
    private readonly alerts: AlertService,
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
      // 1. Every device 2.0 knows, with its account and machine. Tenant-spanning on
      // purpose: the pull is the producer of every account's fault codes, and
      // `sensor_map_projection` forces row security — read from the pool directly, as the
      // first cut did, it returned no devices at all.
      const knownDevices: Array<{ tenant_id: string; source_system: string; external_id: string; imei: string; time_zone: string }> =
        await runTenantSpanning(this.ds, 'dtc pull: device discovery', (m) => m.query(
          `SELECT DISTINCT s.tenant_id, s.source_system, s.external_id, s.imei,
                  coalesce(t.time_zone, 'Asia/Kolkata') AS time_zone
             FROM "sensor_map_projection" s
             LEFT JOIN "tenant" t ON t.tenant_id = s.tenant_id
            WHERE s.imei IS NOT NULL AND s.imei <> ''`,
        ));

      if (knownDevices.length === 0) {
        return { locked: false, devicesPolled: 0, packetsIngested: 0 };
      }

      const imeiMap = new Map<string, { tenantId: string; sourceSystem: string; externalId: string; timeZone: string }>();
      for (const d of knownDevices) {
        imeiMap.set(d.imei, { tenantId: d.tenant_id, sourceSystem: d.source_system, externalId: d.external_id, timeZone: d.time_zone });
      }
      const imeis = Array.from(imeiMap.keys());

      // 2. Where each device's pull got to (platform-owned table, no tenant column).
      const watermarks: Array<{ imei: string; last_packet_time: Date }> = await this.ds.query(
        `SELECT "imei", "last_packet_time" FROM "dtc_pull_watermark" WHERE "imei" = ANY($1::text[])`,
        [imeis],
      );
      const watermarkMap = new Map<string, Date>(watermarks.map((w) => [w.imei, new Date(w.last_packet_time)]));

      const fallbackFrom = new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * 3600_000);
      let totalPackets = 0;
      let cleared = 0;
      let alertsRaised = 0;
      const opened = new Set<string>();

      // 3. Coded packets per device, from its watermark.
      for (const imei of imeis) {
        const from = watermarkMap.get(imei) ?? fallbackFrom;
        const target = imeiMap.get(imei)!;
        const packets = await this.packetReader.pullPackets({ imeis: [imei], from, to: now, limit: 1000 });
        if (packets.length === 0) continue;

        let newestTime = from;
        let newestPacketId: string | null = null;
        for (const packet of packets) {
          const { active } = await this.episodeService.processPacket(target.tenantId, target.externalId, packet, target.sourceSystem);
          if (active.some((e) => Number((e as unknown as { occurrences: number }).occurrences) === 1)) opened.add(imei);
          if (packet.timestamp > newestTime) {
            newestTime = packet.timestamp;
            newestPacketId = packet.packetId;
          }
          totalPackets++;
        }

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

      // 4. Clear what each machine has run ten minutes without. Its codeless packets are
      // never pulled, so its newest running packet of any kind is asked for separately.
      const latest = await this.packetReader.latestRunningPackets(imeis, fallbackFrom);
      for (const { imei, at } of latest) {
        const target = imeiMap.get(imei);
        if (!target) continue;
        cleared += (await this.episodeService.sweepClears(target.tenantId, target.sourceSystem, target.externalId, at)).length;
      }

      // 5. A newly opened code is judged by the account's fault-code rules now, not at the
      // shift's close: a red lamp is the alert somebody needs while the machine is running.
      for (const imei of opened) {
        const target = imeiMap.get(imei)!;
        try {
          const fired = await this.alerts.evaluateWindow({
            tenantId: target.tenantId, sourceSystem: target.sourceSystem, externalId: target.externalId,
            shiftLocalDate: new Intl.DateTimeFormat('en-CA', { timeZone: target.timeZone }).format(now),
            windowStart: watermarkMap.get(imei) ?? fallbackFrom, windowEnd: now,
            readings: [], predictions: [], onlyTriggers: ['dtc'],
          });
          alertsRaised += fired.length;
        } catch (error) {
          this.logger.warn(`Fault-code alerts not judged for ${target.externalId} this pass: ${(error as Error).message}`);
        }
      }

      return {
        locked: false,
        devicesPolled: imeis.length,
        packetsIngested: totalPackets,
        cleared,
        alertsRaised,
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
