import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { DeviceDtcEpisode, DtcEpisodeStatus } from '../entities/device-dtc-episode.entity';
import { DecodedTelemetryPacket, DecodedDtc } from './dtc-packet-decoder';
import { AlertEvent } from '../../alert/entities/alert-event.entity';
import { absorbAlerts } from '../../incident/incident-absorb';
import { Severity } from '../../common/severity';

export const CONSECUTIVE_MISSING_THRESHOLD = 3;
export const ACTIVE_ABSENT_WINDOW_MS = 60_000; // 60 seconds
export const DEFAULT_RETENTION_DAYS = 90;

@Injectable()
export class DtcEpisodeService {
  private readonly logger = new Logger(DtcEpisodeService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Processes a telemetry packet containing decoded DTCs for a machine.
   *
   * Enforces debouncing rules:
   * - Absence from a single packet does NOT clear the code (prevents flapping on packet drops).
   * - Transitions to 'cleared' only after 3 consecutive absences or 60 seconds of active telemetry.
   * - Key-off / engine-off: pauses clearing rather than falsely resolving active faults.
   * - Auto-raises Critical incidents for Red Stop Lamp / Protect Lamp.
   */
  async processPacket(
    tenantId: string,
    externalId: string,
    packet: DecodedTelemetryPacket,
    sourceSystem = 'ta-2.0',
  ): Promise<{ active: DeviceDtcEpisode[]; cleared: DeviceDtcEpisode[]; alertsRaised: number }> {
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
      const alertsToRaise: AlertEvent[] = [];
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

          // Automatic safety alert for Red Stop Lamp / Protect Lamp or critical severity
          if (dtc.lampStatus === 'red_stop' || dtc.lampStatus === 'protect' || dtc.severity === 'critical') {
            const alert = new AlertEvent();
            alert.tenantId = tenantId;
            alert.ruleId = '00000000-0000-0000-0000-000000000001';
            alert.ruleName = 'OEM Diagnostic Safety Stop (Red Lamp)';
            alert.sourceSystem = sourceSystem;
            alert.externalId = externalId;
            alert.severity = Severity.Critical;
            alert.summary = `Active diagnostic fault ${dtc.code} triggered ${dtc.lampStatus} lamp shutdown`;
            alert.evidence = {
              code: dtc.code,
              spn: dtc.spn,
              fmi: dtc.fmi,
              lampStatus: dtc.lampStatus,
              firstSeenAt: packet.timestamp.toISOString(),
            };
            alert.firedAt = packet.timestamp;
            alert.state = 'open';

            const [savedAlert] = await m.query(
              `INSERT INTO "alert_event" (
                  "tenant_id", "rule_id", "rule_name", "source_system", "external_id",
                  "severity", "summary", "evidence", "state", "fired_at"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
                RETURNING *`,
              [
                alert.tenantId, alert.ruleId, alert.ruleName, alert.sourceSystem,
                alert.externalId, alert.severity, alert.summary, JSON.stringify(alert.evidence),
                alert.state, alert.firedAt,
              ],
            );
            if (savedAlert) alertsToRaise.push(savedAlert);
          }
        }
      }

      // 3. Debounce clearing for codes absent from this packet
      // Key-off guard: only process clears if engine is running
      const isEngineRunning = packet.engineRunning !== false;

      if (isEngineRunning) {
        for (const [code, episode] of activeMap.entries()) {
          if (!incomingCodes.has(code)) {
            const newMissingCount = episode.consecutiveMissingCount + 1;
            const msSinceLastSeen = packet.timestamp.getTime() - new Date(episode.lastSeenAt).getTime();

            if (newMissingCount >= CONSECUTIVE_MISSING_THRESHOLD || msSinceLastSeen >= ACTIVE_ABSENT_WINDOW_MS) {
              // Code confirmed cleared
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

      // 4. If any critical safety alerts were raised, absorb into incidents
      if (alertsToRaise.length > 0) {
        await absorbAlerts(m, tenantId, alertsToRaise);
      }

      return {
        active: updatedEpisodes,
        cleared: clearedEpisodes,
        alertsRaised: alertsToRaise.length,
      };
    });
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
   * Prunes cleared episodes older than retention window (default 90 days).
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
