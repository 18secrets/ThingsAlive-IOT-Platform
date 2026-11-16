import { DataSource } from 'typeorm';
import type { NormalizedDtcDefinition } from '../../legacy/legacy-dtc-master.reader';

/**
 * Writes 1.0's fault-code definitions into 2.0's own `dtc_master_catalog`.
 *
 * Here, not in the legacy reader: nothing under src/legacy/ may hold a writing statement
 * (test/wiring.spec.ts), so that a write against 1.0 cannot hide among writes that are
 * really 2.0's. This one is 2.0's — the reader reads, this writes — and keeping the two
 * apart is what lets that test stay crude and still mean something. It failed on main
 * from 13 Nov 2026, holding every Development deploy, while the two lived together.
 *
 * Only the protocols 1.0 knows reach this (j1939, obd2): the pump logger's `pcode` rows
 * are seeded by MotorPCodes1765200000000 and never overwritten from here.
 */
export async function upsertMasterDefinitions(
  ds: DataSource,
  definitions: readonly NormalizedDtcDefinition[],
): Promise<number> {
  for (const d of definitions) {
    await ds.query(
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
      [d.protocol, d.code, d.spn, d.fmi, d.description, d.lamp, d.severity, d.causes, d.remedies],
    );
  }
  return definitions.length;
}
