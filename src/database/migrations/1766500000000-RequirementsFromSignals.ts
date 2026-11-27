import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Requirement rows for every class version that has a signal list and none (TC_276).
 *
 * The New Class form wrote its signals, required flag and all, only into the deprecated
 * `expected_signals` jsonb. Coverage reads `equipment_class_sensor_requirement`, so a type
 * made on the form had no required signals as far as onboarding could tell: every machine
 * of it read "This machine type has no required signals yet", and mapping could never
 * finish. Coverage now falls back to the signal list for a version with no rows at all
 * (SignalBindingService); this writes the rows themselves, so every other reader of the
 * table sees what coverage sees.
 *
 * Only versions with no requirement row at all: one with any row was made by an import or
 * by hand, and its rows already say what it requires. The same rule as coverage's fallback: required
 * is `required`, the rest `recommended`, whole-machine, one probe. Published versions are
 * included on purpose — the tester's type is published and granted — and an insert into a
 * published version is allowed (1759300000000-PublishedClassImmutable refuses edits and
 * removals, not additions).
 *
 * Library types seeded with a signal list and no rows are in it too. Their machines move
 * from "no required signals yet" to asking for those signals to be mapped, which is what
 * the list always said they needed.
 *
 * Each row is marked in `notes`, so `down` removes exactly what `up` wrote.
 */
export class RequirementsFromSignals1766500000000 implements MigrationInterface {
  name = 'RequirementsFromSignals1766500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO "equipment_class_sensor_requirement"
        ("class_slug", "class_version", "measurement_role", "component_scope", "criticality",
         "min_count", "canonical_unit", "enables", "notes", "source")
      SELECT ecp."slug", ecp."version", btrim(sig->>'signal'), '',
             CASE WHEN lower(coalesce(sig->>'required', '')) IN ('true', 't', '1') THEN 'required' ELSE 'recommended' END,
             1, nullif(btrim(coalesce(sig->>'unit', '')), ''), '{}', $1, 'manual'
        FROM "equipment_class_profile" ecp
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ecp."expected_signals") = 'array' THEN ecp."expected_signals" ELSE '[]'::jsonb END
        ) AS sig
       WHERE jsonb_typeof(sig) = 'object'
         AND btrim(coalesce(sig->>'signal', '')) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM "equipment_class_sensor_requirement" r
            WHERE r."class_slug" = ecp."slug" AND r."class_version" = ecp."version")
      -- A list naming one signal twice keeps the first; the unique index would refuse the second.
      ON CONFLICT ("class_slug", "class_version", "measurement_role", "component_scope") DO NOTHING`,
    [BACKFILL_NOTE]);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "equipment_class_sensor_requirement" WHERE "notes" = $1`, [BACKFILL_NOTE]);
  }
}

const BACKFILL_NOTE = 'From the signal list (migration 1766500000000-RequirementsFromSignals, TC_276).';
