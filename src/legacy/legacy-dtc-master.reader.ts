import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LEGACY_DATA_SOURCE } from './legacy-source';
import { DtcLamp, DtcProtocol } from '../diagnostics/entities/dtc-master.entity';
import { Severity } from '../common/severity';

/** A row of 1.0's `dtc_master` (`iot_platform_backend/src/dtcc-error/entity/dtc-error.entity.ts`).
 * spn and fmi are text there; a J1939 code has them, a P-code has `p_code`. */
export interface LegacyDtcMasterRow {
  source_type?: string;
  dtc_code?: string | null;
  p_code?: string | null;
  spn?: string | number | null;
  fmi?: string | number | null;
  description?: string | null;
  category?: string | null;
  lamp?: string | null;
  causes?: string | null;
  remedies?: string | null;
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

    // 1.0's real columns. The first cut asked for "code", "protocol" and "severity",
    // which dtc_master does not have, so the read failed and the mirror stayed empty.
    // A failure now throws rather than reading as "no codes defined".
    const rows: LegacyDtcMasterRow[] = await this.legacy.query(`
      SELECT "source_type", "dtc_code", "p_code", "spn", "fmi",
             COALESCE(NULLIF("description_simp", ''), "description") AS "description",
             "category", "lamp", "causes", "remedies"
        FROM "${schema}"."dtc_master"
    `);

    if (rows.length === 0) return 0;

    let syncedCount = 0;
    for (const r of rows) {
      // Keyed as the packet decoder keys what a machine sends, so a code and its meaning
      // meet one to one: J1939 as SPN:<spn>:FMI:<fmi>, a P-code by its own text.
      const spn = r.spn != null && `${r.spn}`.trim() !== '' && Number.isFinite(Number(r.spn)) ? Number(r.spn) : null;
      const fmi = r.fmi != null && `${r.fmi}`.trim() !== '' && Number.isFinite(Number(r.fmi)) ? Number(r.fmi) : null;
      const pCode = (r.p_code ?? '').trim().toUpperCase();
      let protocol: DtcProtocol;
      let code: string;
      if (spn !== null && fmi !== null) { protocol = 'j1939'; code = `SPN:${spn}:FMI:${fmi}`; }
      else if (pCode) { protocol = 'obd2'; code = pCode; }
      else continue;
      const lampLower = (r.lamp || '').toLowerCase();
      let lamp: DtcLamp = 'none';
      if (lampLower.includes('red') || lampLower.includes('stop')) lamp = 'red_stop';
      else if (lampLower.includes('protect')) lamp = 'protect';
      else if (lampLower.includes('amber') || lampLower.includes('warning')) lamp = 'amber_warning';
      else if (lampLower.includes('mil')) lamp = 'mil';

      const sevLower = (r.category || '').toLowerCase();
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
