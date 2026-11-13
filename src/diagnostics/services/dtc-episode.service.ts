import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeviceDtcEpisode } from '../entities/device-dtc-episode.entity';
import { DecodedTelemetryPacket } from './dtc-packet-decoder';
import { Severity } from '../../common/severity';

export const CONSECUTIVE_MISSING_THRESHOLD = 3;
export const ACTIVE_ABSENT_WINDOW_MS = 10 * 60_000; // 10 minutes (Deepak decision #4)
export const DEFAULT_RETENTION_DAYS = 90; // 90 days (Deepak decision #5)

export interface EquipmentFaultItem {
  id: string;
  code: string;
  protocol: string;
  spn: number | null;
  fmi: number | null;
  lamp: string;
  severity: Severity;
  description: string;
  causes: string | null;
  remedies: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string | null;
  occurrences: number;
}

export interface EquipmentFaultsResponse {
  reportsFaults: boolean;
  active: EquipmentFaultItem[];
  history: EquipmentFaultItem[];
}

@Injectable()
export class DtcEpisodeService {
  private readonly logger = new Logger(DtcEpisodeService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Processes a telemetry packet containing decoded DTCs for a machine.
   *
   * Enforces debouncing rules:
   * - Absence from a single packet does NOT clear the code (prevents flapping on packet drops).
   * - Transitions to 'cleared' after 10 minutes of packets where the code is absent (Deepak decision #4).
   * - Key-off / engine-off: pauses clearing rather than falsely resolving active faults.
   * - Alert generation is deferred to user-configured alert rules in Phase 2 (Deepak decision #6).
   */
  async processPacket(
    tenantId: string,
    externalId: string,
    packet: DecodedTelemetryPacket,
    sourceSystem = 'ta-2.0',
  ): Promise<{ active: DeviceDtcEpisode[]; cleared: DeviceDtcEpisode[] }> {
    return this.ds.transaction(async (m: EntityManager) => {
      // 1. Load current active episodes for this machine
      const existingActive: DeviceDtcEpisode[] = await m.query(
        `SELECT * FROM "device_dtc_episode"
          WHERE "tenant_id" = $1 AND "external_id" = $2 AND "status" = 'active'
          FOR UPDATE`,
        [tenantId, externalId],
      );

      const activeMap = new Map<string, DeviceDtcEpisode>(
        existingActive.map((ep) => [ep.code, ep]),
      );

      const incomingCodes = new Set<string>();
      const updatedEpisodes: DeviceDtcEpisode[] = [];
      const clearedEpisodes: DeviceDtcEpisode[] = [];

      // 2. Process incoming active DTCs
      for (const dtc of packet.dtcs) {
        incomingCodes.add(dtc.code);
        const existing = activeMap.get(dtc.code);

        if (existing) {
          // Increment occurrences and update last_seen_at; reset consecutive_missing_count
          const [updated] = await m.query(
            `UPDATE "device_dtc_episode"
                SET "last_seen_at" = $1,
                    "occurrences" = "occurrences" + 1,
                    "consecutive_missing_count" = 0,
                    "lamp_status" = CASE WHEN $2 IN ('red_stop', 'protect') THEN $2 ELSE "lamp_status" END,
                    "severity" = CASE WHEN $3 = 'critical' THEN $3 ELSE "severity" END,
                    "updated_at" = now()
              WHERE "id" = $4
              RETURNING *`,
            [packet.timestamp, dtc.lampStatus, dtc.severity, existing.id],
          );
          if (updated) updatedEpisodes.push(updated);
        } else {
          // New episode
          const [created] = await m.query(
            `INSERT INTO "device_dtc_episode" (
                "tenant_id", "source_system", "external_id", "imei", "protocol",
                "code", "spn", "fmi", "lamp_status", "severity", "status",
                "first_seen_at", "last_seen_at", "occurrences", "consecutive_missing_count"
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $11, 1, 0)
              RETURNING *`,
            [
              tenantId,
              sourceSystem,
              externalId,
              packet.imei,
              dtc.protocol,
              dtc.code,
              dtc.spn ?? null,
              dtc.fmi ?? null,
              dtc.lampStatus,
              dtc.severity,
              packet.timestamp,
            ],
          );
          if (created) updatedEpisodes.push(created);
        }
      }

      // 3. Debounce clearing for codes absent from this packet
      // Key-off guard: only process clears if engine is running
      const isEngineRunning = packet.engineRunning !== false;

      if (isEngineRunning) {
        for (const [code, episode] of activeMap.entries()) {
          if (!incomingCodes.has(code)) {
            const currentMissing = episode.consecutiveMissingCount ?? (episode as any).consecutive_missing_count ?? 0;
            const newMissingCount = Number(currentMissing) + 1;
            const lastSeen = episode.lastSeenAt ?? (episode as any).last_seen_at;
            const msSinceLastSeen = packet.timestamp.getTime() - new Date(lastSeen).getTime();

            if (newMissingCount >= CONSECUTIVE_MISSING_THRESHOLD && msSinceLastSeen >= ACTIVE_ABSENT_WINDOW_MS) {
              // Code confirmed cleared after 10 minutes of absent telemetry packets
              const [cleared] = await m.query(
                `UPDATE "device_dtc_episode"
                    SET "status" = 'cleared',
                        "cleared_at" = $1,
                        "consecutive_missing_count" = $2,
                        "updated_at" = now()
                  WHERE "id" = $3
                  RETURNING *`,
                [packet.timestamp, newMissingCount, episode.id],
              );
              if (cleared) clearedEpisodes.push(cleared);
            } else {
              // Increment missing count but hold active
              await m.query(
                `UPDATE "device_dtc_episode"
                    SET "consecutive_missing_count" = $1,
                        "updated_at" = now()
                  WHERE "id" = $2`,
                [newMissingCount, episode.id],
              );
            }
          }
        }
      }

      return {
        active: updatedEpisodes,
        cleared: clearedEpisodes,
      };
    });
  }

  /**
   * Retrieves unified equipment faults payload matching Premchand's Route 4 spec:
   * GET /equipment/:ss/:id/faults
   *
   * Returns whether this device reports fault codes at all, its active codes and their history,
   * enriched with the description, lamp, causes and remedies from dtc_master_catalog.
   */
  async getEquipmentFaults(
    tenantId: string,
    sourceSystem: string,
    externalId: string,
  ): Promise<EquipmentFaultsResponse> {
    // 1. Determine whether this machine's device reports fault codes at all
    // Check if any episode (active or historical) exists, or if device's watermark is registered
    const [presence] = await this.ds.query(
      `SELECT EXISTS (
         SELECT 1 FROM "device_dtc_episode"
          WHERE "tenant_id" = $1 AND "external_id" = $2
       ) AS has_episodes,
       EXISTS (
         SELECT 1 FROM "sensor_map_projection" s
          JOIN "dtc_pull_watermark" w ON w.imei = s.imei
          WHERE s.tenant_id = $1 AND s.external_id = $2
       ) AS has_watermark`,
      [tenantId, externalId],
    );

    const reportsFaults = Boolean(presence?.has_episodes || presence?.has_watermark);

    // If the machine's device has never sent DTCs, no panel should be shown (no empty box)
    if (!reportsFaults) {
      return {
        reportsFaults: false,
        active: [],
        history: [],
      };
    }

    // 2. Query episodes joined with dtc_master_catalog
    const rows = await this.ds.query(
      `SELECT e.id,
              e.code,
              e.protocol,
              e.spn,
              e.fmi,
              e.lamp_status AS lamp,
              e.severity,
              e.status,
              e.first_seen_at AS "firstSeenAt",
              e.last_seen_at AS "lastSeenAt",
              e.cleared_at AS "clearedAt",
              e.occurrences,
              COALESCE(m.description, e.code) AS description,
              m.causes,
              m.remedies
         FROM "device_dtc_episode" e
         LEFT JOIN "dtc_master_catalog" m
           ON (e.protocol = m.protocol AND e.code = m.code)
           OR (e.spn IS NOT NULL AND e.spn = m.spn AND e.fmi IS NOT NULL AND e.fmi = m.fmi)
        WHERE e.tenant_id = $1
          AND e.external_id = $2
        ORDER BY
          CASE WHEN e.status = 'active' THEN 0 ELSE 1 END,
          CASE WHEN e.lamp_status = 'red_stop' THEN 0
               WHEN e.lamp_status = 'protect' THEN 1
               WHEN e.lamp_status = 'amber_warning' THEN 2
               ELSE 3 END,
          e.last_seen_at DESC`,
      [tenantId, externalId],
    );

    const active: EquipmentFaultItem[] = [];
    const history: EquipmentFaultItem[] = [];

    for (const r of rows) {
      const item: EquipmentFaultItem = {
        id: r.id,
        code: r.code,
        protocol: r.protocol,
        spn: r.spn ?? null,
        fmi: r.fmi ?? null,
        lamp: r.lamp,
        severity: r.severity,
        description: r.description,
        causes: r.causes ?? null,
        remedies: r.remedies ?? null,
        firstSeenAt: new Date(r.firstSeenAt).toISOString(),
        lastSeenAt: new Date(r.lastSeenAt).toISOString(),
        clearedAt: r.clearedAt ? new Date(r.clearedAt).toISOString() : null,
        occurrences: Number(r.occurrences ?? 1),
      };

      if (r.status === 'active') {
        active.push(item);
      } else {
        if (history.length < 20) {
          history.push(item);
        }
      }
    }

    return {
      reportsFaults: true,
      active,
      history,
    };
  }

  /**
   * Retrieves all currently active DTC episodes for an equipment.
   */
  async getActiveEpisodes(tenantId: string, externalId: string): Promise<DeviceDtcEpisode[]> {
    return this.ds.query(
      `SELECT * FROM "device_dtc_episode"
        WHERE "tenant_id" = $1 AND "external_id" = $2 AND "status" = 'active'
        ORDER BY "last_seen_at" DESC`,
      [tenantId, externalId],
    );
  }

  /**
   * Retrieves DTC history (both active and cleared) within a time window.
   */
  async getHistory(
    tenantId: string,
    externalId: string,
    from?: Date,
    to?: Date,
  ): Promise<DeviceDtcEpisode[]> {
    const params: unknown[] = [tenantId, externalId];
    let sql = `SELECT * FROM "device_dtc_episode" WHERE "tenant_id" = $1 AND "external_id" = $2`;

    if (from) {
      params.push(from);
      sql += ` AND "last_seen_at" >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      sql += ` AND "first_seen_at" <= $${params.length}`;
    }

    sql += ` ORDER BY "first_seen_at" DESC`;
    return this.ds.query(sql, params);
  }

  /**
   * Prunes cleared episodes older than retention window (90 days).
   */
  async pruneHistory(olderThanDays = DEFAULT_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const result = await this.ds.query(
      `DELETE FROM "device_dtc_episode"
        WHERE "status" = 'cleared' AND "cleared_at" < $1`,
      [cutoff],
    );
    return result[1] ?? 0;
  }
}
