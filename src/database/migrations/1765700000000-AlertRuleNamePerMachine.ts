import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One enabled rule of a name per machine, held by the database (TC_199).
 *
 * `uq_alert_rule_slug` was the only rule, and the slug is not what anybody sees. The
 * workflow editor stamps every new workflow's slug with the time, so publishing "Coolant
 * hot" twice on EX-07 wrote two enabled rules nobody could tell apart in the list, and
 * every breach raised two alerts. The name is what a person reads, so the name is what
 * has to be unique — compared trimmed and case-blind, because "Coolant hot" and
 * "coolant hot " are the same rule to the person reading the list.
 *
 * Enabled only. Republishing a workflow switches its old rules off and writes new ones
 * under the same names, and alert events keep pointing at the old ones; a rule that is
 * off is history and may share its name. Switching one back on is where a clash is
 * refused. Machine-scoped only, because that is the case the testing sheet raised; a
 * site- or account-wide rule of the same name covers other machines too, and whether
 * that is a duplicate has not been decided.
 *
 * Duplicates already present are renamed, not switched off: two rules of one name can
 * still say different things, and switching one off would quietly stop an alert
 * somebody relies on. The oldest keeps the name; the rest become "Name (2)", "Name (3)"
 * — the next free one — so each still fires and each can now be told apart.
 */
export class AlertRuleNamePerMachine1765700000000 implements MigrationInterface {
  name = 'AlertRuleNamePerMachine1765700000000';

  public async up(q: QueryRunner): Promise<void> {
    // alert_rule forces row-level security; without the bypass a migration that is not
    // run as a superuser would see no account's rows and rename nothing, and the index
    // below would then fail on the duplicates it could not see.
    await q.query(`SET LOCAL "ta.bypass" = 'on'`);
    await q.query(`
      DO $$
      DECLARE
        r record;
        n int;
        candidate text;
      BEGIN
        FOR r IN
          SELECT "id", "name", "tenant_id", "source_system", "external_id",
                 row_number() OVER (
                   PARTITION BY "tenant_id", "source_system", "external_id", lower(btrim("name"))
                   ORDER BY "created_at", "id") AS rn
            FROM "alert_rule"
           WHERE "enabled" AND "applies_to" = 'equipment'
        LOOP
          CONTINUE WHEN r.rn = 1;
          n := r.rn;
          LOOP
            candidate := btrim(r."name") || ' (' || n || ')';
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM "alert_rule" o
               WHERE o."enabled" AND o."applies_to" = 'equipment'
                 AND o."tenant_id" = r."tenant_id" AND o."source_system" = r."source_system"
                 AND o."external_id" = r."external_id" AND lower(btrim(o."name")) = lower(candidate));
            n := n + 1;
          END LOOP;
          UPDATE "alert_rule" SET "name" = candidate, "updated_at" = now() WHERE "id" = r."id";
        END LOOP;
      END $$`);
    await q.query(`SET LOCAL "ta.bypass" = 'off'`);
    await q.query(`
      CREATE UNIQUE INDEX "uq_alert_rule_machine_name"
        ON "alert_rule" ("tenant_id", "source_system", "external_id", lower(btrim("name")))
        WHERE "enabled" AND "applies_to" = 'equipment'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The renames stay: the old names were the bug, and nothing records which they were.
    await q.query(`DROP INDEX IF EXISTS "uq_alert_rule_machine_name"`);
  }
}
