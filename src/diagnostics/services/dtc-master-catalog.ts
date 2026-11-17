import { DataSource, EntityManager } from 'typeorm';
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
 * Only the protocols 1.0 knows reach this (j1939, obd2); the pump logger's P-codes live
 * in `fault_code_motor` (FaultCodeLibrary1765300000000), out of its reach. A vehicle code
 * 2.0 holds as its own (`source_system` 2.0) is not overwritten either: 1.0's copy updates
 * only rows that are 1.0's, so a 2.0 edit cannot be lost to the next morning's sync.
 */
export async function upsertMasterDefinitions(
  ds: DataSource,
  definitions: readonly NormalizedDtcDefinition[],
): Promise<number> {
  // One transaction that says it is the copy from 1.0: the vehicle table's owner guard
  // (FaultCodeEditing1765400000000) lets only this write a 1.0 row, and refuses it a 2.0
  // one. SET LOCAL semantics, so the flag cannot outlive the copy on a pooled connection.
  return ds.transaction(async (m) => {
    await m.query(`SELECT set_config('ta.fault_code_sync', 'on', true)`);
    for (const d of definitions) await writeDefinition(m, d);
    return definitions.length;
  });
}

async function writeDefinition(m: EntityManager, d: NormalizedDtcDefinition): Promise<void> {
  await m.query(
    `INSERT INTO "dtc_master_catalog" (
        "protocol", "code", "spn", "fmi", "description", "lamp", "severity", "causes", "remedies", "source_unit", "oem_code",
        "source_system", "updated_at"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '1.0', now())
      ON CONFLICT ("protocol", "code") DO UPDATE
        SET "description" = EXCLUDED."description",
            "lamp" = EXCLUDED."lamp",
            "severity" = EXCLUDED."severity",
            "causes" = EXCLUDED."causes",
            "remedies" = EXCLUDED."remedies",
            "source_unit" = EXCLUDED."source_unit",
            "oem_code" = EXCLUDED."oem_code",
            "updated_at" = now()
        WHERE "dtc_master_catalog"."source_system" = '1.0'`,
    [d.protocol, d.code, d.spn, d.fmi, d.description, d.lamp, d.severity, d.causes, d.remedies, d.sourceUnit ?? null, d.oemCode ?? null],
  );
}
