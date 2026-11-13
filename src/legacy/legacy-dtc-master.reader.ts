import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LEGACY_DATA_SOURCE } from './legacy-source';
import { DtcLamp, DtcProtocol } from '../diagnostics/entities/dtc-master.entity';
import { Severity } from '../common/severity';

export interface LegacyDtcMasterRow {
  protocol?: string;
  dtc_code?: string;
  code?: string;
  spn?: number | string;
  fmi?: number | string;
  description?: string;
  lamp?: string;
  severity?: string;
  causes?: string;
  remedies?: string;
}

export interface NormalizedDtcDefinition {
  protocol: DtcProtocol;
  code: string;
  spn: number | null;
  fmi: number | null;
  description: string;
  lamp: DtcLamp;
  severity: Severity;
  causes: string | null;
  remedies: string | null;
}

/**
 * Reads DTC master catalogs from 1.0 `dtc_master` (or legacy `dtcc_error_code` tables).
 */
@Injectable()
export class LegacyDtcMasterReader {
  private readonly logger = new Logger(LegacyDtcMasterReader.name);

  constructor(
    @Optional() @Inject(LEGACY_DATA_SOURCE) private readonly legacy?: DataSource | null,
  ) {}

  async syncMasterCatalog(localDs: DataSource, schema = 'public'): Promise<number> {
    if (!this.legacy?.isInitialized) return 0;

    let rows: LegacyDtcMasterRow[] = [];

    // Attempt read from dtc_master first
    try {
      rows = await this.legacy.query(`
        SELECT "code", "spn", "fmi", "protocol", "description", "lamp", "severity", "causes", "remedies"
          FROM "${schema}"."dtc_master"
      `);
    } catch {
      // Fallback: check dtcc_error_code / dtcc_error_code_above125kva
      try {
        rows = await this.legacy.query(`
          SELECT "dtc_code" AS "code", NULL AS "spn", NULL AS "fmi", 'obd2' AS "protocol",
                 "description", "lamp", 'high' AS "severity", "causes", "remedies"
            FROM "${schema}"."dtcc_error_code"
        `);
      } catch (err: any) {
        this.logger.warn(`Could not read 1.0 dtc_master or dtcc_error_code: ${err.message}`);
        return 0;
      }
    }

    if (rows.length === 0) return 0;

    let syncedCount = 0;
    for (const r of rows) {
      const code = (r.code || r.dtc_code || '').trim();
      if (!code) continue;

      const protocol: DtcProtocol = (r.protocol?.toLowerCase() === 'j1939' || r.spn != null) ? 'j1939' : 'obd2';
      const spn = r.spn != null ? Number(r.spn) : null;
      const fmi = r.fmi != null ? Number(r.fmi) : null;
      const lampLower = (r.lamp || '').toLowerCase();
      let lamp: DtcLamp = 'none';
      if (lampLower.includes('red') || lampLower.includes('stop')) lamp = 'red_stop';
      else if (lampLower.includes('protect')) lamp = 'protect';
      else if (lampLower.includes('amber') || lampLower.includes('warning')) lamp = 'amber_warning';
      else if (lampLower.includes('mil')) lamp = 'mil';

      const sevLower = (r.severity || '').toLowerCase();
      let severity: Severity = Severity.Medium;
      if (lamp === 'red_stop' || lamp === 'protect' || sevLower === 'critical') severity = Severity.Critical;
      else if (lamp === 'amber_warning' || sevLower === 'high') severity = Severity.High;
      else if (sevLower === 'low') severity = Severity.Low;

      await localDs.query(
        `INSERT INTO "dtc_master_catalog" (
            "protocol", "code", "spn", "fmi", "description", "lamp", "severity", "causes", "remedies", "source_system", "updated_at"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '1.0', now())
          ON CONFLICT ("protocol", "code") DO UPDATE
            SET "description" = EXCLUDED."description",
                "lamp" = EXCLUDED."lamp",
                "severity" = EXCLUDED."severity",
                "causes" = EXCLUDED."causes",
                "remedies" = EXCLUDED."remedies",
                "updated_at" = now()`,
        [protocol, code, spn, fmi, r.description || code, lamp, severity, r.causes ?? null, r.remedies ?? null],
      );
      syncedCount++;
    }

    this.logger.log(`Synced ${syncedCount} DTC definitions from 1.0`);
    return syncedCount;
  }
}
