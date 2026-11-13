import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeviceDtcEpisode } from '../entities/device-dtc-episode.entity';
import { DecodedTelemetryPacket } from './dtc-packet-decoder';
import { Severity } from '../../common/severity';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantId, withTenantSession, runTenantSpanning } from '../../scope/tenant-session';

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
   * Runs inside an explicit tenant session (or caller-supplied spanning manager)
   * so that Postgres row-level security policies on `device_dtc_episode` allow the write.
   */
  async processPacket(
    tenantId: string,
    externalId: string,
    packet: DecodedTelemetryPacket,
    sourceSystem = 'ta-2.0',
    externalManager?: EntityManager,
  ): Promise<{ active: DeviceDtcEpisode[]; cleared: DeviceDtcEpisode[] }> {
    const executeInManager = async (m: EntityManager) => {
      // 1. Load current active episodes for this machine within tenant scope
      const existingActive: DeviceDtcEpisode[] = await m.query(
        `SELECT * FROM "device_dtc_episode"
          WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "status" = 'active'
          FOR UPDATE`,
        [tenantId, sourceSystem, externalId],
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
          // Insert new active episode; partial unique index on (tenant, source_system, machine, code) WHERE status = 'active'
          // guarantees integrity and prevents duplicate active rows.
          const [created] = await m.query(
            `INSERT INTO "device_dtc_episode" (
                "tenant_id", "source_system", "external_id", "imei", "protocol",
                "code", "spn", "fmi", "lamp_status", "severity", "status",
                "first_seen_at", "last_seen_at", "occurrences", "consecutive_missing_count"
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $11, 1, 0)
              ON CONFLICT ("tenant_id", "source_system", "external_id", "code") WHERE "status" = 'active'
              DO UPDATE SET "last_seen_at" = EXCLUDED."last_seen_at",
                            "occurrences" = "device_dtc_episode"."occurrences" + 1,
                            "consecutive_missing_count" = 0,
                            "lamp_status" = CASE WHEN EXCLUDED."lamp_status" IN ('red_stop', 'protect') THEN EXCLUDED."lamp_status" ELSE "device_dtc_episode"."lamp_status" END,
                            "severity" = CASE WHEN EXCLUDED."severity" = 'critical' THEN EXCLUDED."severity" ELSE "device_dtc_episode"."severity" END,
                            "updated_at" = now()
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
    };

    if (externalManager) {
      return executeInManager(externalManager);
    }
    return withTenantId(this.ds, tenantId, executeInManager);
  }

  /**
   * Retrieves unified equipment faults payload matching Premchand's Route 4 spec:
   * GET /equipment/:sourceSystem/:externalId/faults
   *
   * Executes under `withTenantSession` so forced row-level security on `device_dtc_episode`
   * scopes results strictly to the authenticated account.
   */
  async getEquipmentFaults(
    scope: RequestScope,
    sourceSystem: string,
    externalId: string,
  ): Promise<EquipmentFaultsResponse> {
    return withTenantSession(this.ds, scope, async (m) => {
      // 1. Determine whether this machine's device reports fault codes at all
      const [presence] = await m.query(
        `SELECT EXISTS (
           SELECT 1 FROM "device_dtc_episode"
            WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3
         ) AS has_episodes,
         EXISTS (
           SELECT 1 FROM "sensor_map_projection" s
            JOIN "dtc_pull_watermark" w ON w.imei = s.imei
            WHERE s.tenant_id = $1 AND s.source_system = $2 AND s.external_id = $3
         ) AS has_watermark`,
        [scope.tenantId, sourceSystem, externalId],
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
      const rows = await m.query(
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
            AND e.source_system = $2
            AND e.external_id = $3
          ORDER BY
            CASE WHEN e.status = 'active' THEN 0 ELSE 1 END,
            CASE WHEN e.lamp_status = 'red_stop' THEN 0
                 WHEN e.lamp_status = 'protect' THEN 1
                 WHEN e.lamp_status = 'amber_warning' THEN 2
                 ELSE 3 END,
            e.last_seen_at DESC`,
        [scope.tenantId, sourceSystem, externalId],
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
    });
  }

  /**
   * Prunes cleared episodes older than retention window (90 days).
   * Runs tenant-spanning since it cleans up historical data across accounts.
   */
  async pruneHistory(olderThanDays = DEFAULT_RETENTION_DAYS): Promise<number> {
    return runTenantSpanning(this.ds, 'dtc-prune-history', async (m) => {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      const result = await m.query(
        `DELETE FROM "device_dtc_episode"
          WHERE "status" = 'cleared' AND "cleared_at" < $1`,
        [cutoff],
      );
      return result[1] ?? 0;
    });
  }
}
