import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ThingsShield evidence records (task QSHIELD1).
 *
 * One inspection or check, against one machine, with what was found and when the next
 * one is due. Nothing here decides what a site is legally required to do — that is the
 * applicability register, and nobody has supplied it yet.
 *
 * A record is evidence, and evidence is immutable (G13). The rules that keep it so live
 * here rather than in the service, because a service check loses to a concurrent write
 * and the next repository method will not know they existed:
 *
 *  - append-only for every role including the owner — a correction is a new row that
 *    supersedes the old one, and the old one stays readable;
 *  - a record is revised at most once, so two people correcting the same record at the
 *    same moment cannot both win and leave two "current" versions;
 *  - a revision stays on the same tenant, machine and category as what it revises;
 *  - somebody owns every record, and a named owner is a user of the same account.
 */
export class ShieldEvidence1759400000000 implements MigrationInterface {
  name = 'ShieldEvidence1759400000000';

  /** The role templates before QSHIELD1 — see `grantToUneditedRoles`. */
  private readonly templatesBefore: Record<string, { before: string[]; add: string[] }> = {
    'ceo-manager': {
      before: [
        'user.manage', 'role.manage', 'equipment.write',
        'scenario.activate', 'scenario.author', 'alert.author', 'action.work', 'action.assign',
        'catalog.read', 'client-catalog.read', 'client-catalog.write',
        'prediction.read', 'prediction.run', 'utilization.read',
        'device.read', 'device.claim',
        'equipment-template.read', 'device-catalog.read',
        'parameters.read', 'parameters.write',
      ],
      add: ['shield.read', 'shield.write'],
    },
    'site-manager': {
      before: [
        'equipment.write', 'scenario.activate', 'alert.author', 'action.work', 'action.assign',
        'catalog.read', 'client-catalog.read',
        'prediction.read', 'prediction.run', 'utilization.read',
        'device.read', 'device.claim',
        'equipment-template.read', 'device-catalog.read',
        'parameters.read',
      ],
      add: ['shield.read', 'shield.write'],
    },
    operator: {
      before: [
        'action.work', 'catalog.read', 'client-catalog.read',
        'prediction.read', 'utilization.read', 'device.read',
        'equipment-template.read', 'device-catalog.read',
      ],
      add: ['shield.read'],
    },
  };

  public async up(q: QueryRunner): Promise<void> {
    // The composite foreign keys below need a unique target. `id` is already unique on
    // its own; these exist so the key can carry the tenant, which is what stops a record
    // in one account naming another account's user as its owner.
    await q.query(`CREATE UNIQUE INDEX "uq_app_user_tenant_id" ON "app_user" ("tenant_id", "id")`);

    await q.query(`
      CREATE TABLE "shield_evidence_record" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "category" text NOT NULL,
        "title" text NOT NULL,
        "result" text NOT NULL,
        "performed_at" timestamptz NOT NULL,
        "due_at" timestamptz,
        "owner_user_id" uuid,
        "owner_name" text,
        "reference" text,
        "findings" text,
        "recorded_by" text NOT NULL,
        "supersedes_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        -- No cascade. Evidence about a machine does not disappear because the machine's
        -- profile did; deleting a profile that has evidence is refused instead.
        CONSTRAINT "fk_shield_evidence_equipment"
          FOREIGN KEY ("tenant_id", "source_system", "external_id")
          REFERENCES "equipment_profile" ("tenant_id", "source_system", "external_id"),
        CONSTRAINT "fk_shield_evidence_owner"
          FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app_user" ("tenant_id", "id"),
        CONSTRAINT "ck_shield_evidence_category"
          CHECK ("category" IN ('compliance', 'safety', 'security')),
        CONSTRAINT "ck_shield_evidence_result"
          CHECK ("result" IN ('passed', 'failed', 'attention')),
        CONSTRAINT "ck_shield_evidence_title"
          CHECK (length(btrim("title")) > 0),
        -- A record nobody owns is a record nobody follows up. A blank name is no owner.
        CONSTRAINT "ck_shield_evidence_owner"
          CHECK ("owner_user_id" IS NOT NULL OR length(btrim(coalesce("owner_name", ''))) > 0),
        -- The next check cannot be due before this one happened.
        CONSTRAINT "ck_shield_evidence_due"
          CHECK ("due_at" IS NULL OR "due_at" >= "performed_at")
      )`);
    // The target of the revision key: a revision names the record it corrects together
    // with that record's tenant, machine and category, so it cannot move any of them.
    await q.query(`
      CREATE UNIQUE INDEX "uq_shield_evidence_identity"
        ON "shield_evidence_record" ("tenant_id", "source_system", "external_id", "category", "id")`);
    await q.query(`
      ALTER TABLE "shield_evidence_record" ADD CONSTRAINT "fk_shield_evidence_supersedes"
        FOREIGN KEY ("tenant_id", "source_system", "external_id", "category", "supersedes_id")
        REFERENCES "shield_evidence_record" ("tenant_id", "source_system", "external_id", "category", "id")`);
    // Revised once. Without this two concurrent corrections each find the record
    // unrevised, both insert, and the machine has two current versions of one check.
    // Leads with the tenant like every tenant-owned unique index, so the key space one
    // account writes into is never shared with another's.
    await q.query(`
      CREATE UNIQUE INDEX "uq_shield_evidence_supersedes"
        ON "shield_evidence_record" ("tenant_id", "supersedes_id") WHERE "supersedes_id" IS NOT NULL`);
    await q.query(`
      CREATE INDEX "ix_shield_evidence_machine"
        ON "shield_evidence_record" ("tenant_id", "source_system", "external_id", "performed_at" DESC)`);

    // A trigger as well as the missing grant: the owner and a managed Postgres's
    // superuser bypass grants, and evidence the right login can rewrite is not evidence.
    await q.query(`
      CREATE FUNCTION "shield_evidence_append_only"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'shield_evidence_record is append-only: correct a record by writing a revision that supersedes it (shield_evidence_append_only)';
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_shield_evidence_append_only"
        BEFORE UPDATE OR DELETE ON "shield_evidence_record"
        FOR EACH ROW EXECUTE FUNCTION "shield_evidence_append_only"()`);

    await q.query(`ALTER TABLE "shield_evidence_record" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "shield_evidence_record" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "shield_evidence_record"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    // SELECT and INSERT only. No UPDATE also means no SELECT ... FOR UPDATE, so the
    // service cannot lock a record to revise it — the unique index above is the lock.
    await q.query(`GRANT SELECT, INSERT ON "shield_evidence_record" TO "ta_app"`);

    // ---------------------------------------------------------- due-soon parameter
    // `shield_due_soon_days` is a whole number of days, at least one. Same constraint,
    // one more arm: the other arms are copied unchanged from TenantParameters.
    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`
      ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value"
        CHECK (CASE
          WHEN jsonb_typeof("value") = 'null' THEN true
          WHEN "name" = 'currency' THEN
            jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
          WHEN jsonb_typeof("value") <> 'number' THEN false
          WHEN "name" IN ('stale_after_seconds', 'shield_due_soon_days') THEN
            ("value" #>> '{}')::numeric > 0
            AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
          ELSE true
        END)`);

    await this.grantToUneditedRoles(q);
  }

  /**
   * Accounts provisioned before this migration hold copies of the role templates without
   * the shield capabilities, so nobody in them could open ThingsShield. Only a role still
   * exactly the template default is touched (compared as a set, so order does not
   * matter); a role the client has edited is theirs, and adding to it would be Things
   * Alive deciding who in their account sees safety evidence — the same reasoning as
   * `AddTemplateReadCapabilities`.
   */
  private async grantToUneditedRoles(q: QueryRunner): Promise<void> {
    for (const [slug, { before, add }] of Object.entries(this.templatesBefore)) {
      await q.query(
        `UPDATE "tenant_role" SET "capabilities" = "capabilities" || $3::text[]
           WHERE "template_slug" = $1 AND "capabilities" @> $2::text[] AND "capabilities" <@ $2::text[]`,
        [slug, before, add],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    // The role grants are not taken back: by then a client may have relied on them, and
    // the capabilities simply stop matching any route once the table is gone.
    await q.query(`ALTER TABLE "tenant_parameter" DROP CONSTRAINT "ck_tenant_parameter_value"`);
    await q.query(`
      ALTER TABLE "tenant_parameter" ADD CONSTRAINT "ck_tenant_parameter_value"
        CHECK (CASE
          WHEN jsonb_typeof("value") = 'null' THEN true
          WHEN "name" = 'currency' THEN
            jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
          WHEN jsonb_typeof("value") <> 'number' THEN false
          WHEN "name" = 'stale_after_seconds' THEN
            ("value" #>> '{}')::numeric > 0
            AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
          ELSE true
        END)`);
    await q.query(`DROP TABLE IF EXISTS "shield_evidence_record"`);
    await q.query(`DROP FUNCTION IF EXISTS "shield_evidence_append_only"()`);
    await q.query(`DROP INDEX IF EXISTS "uq_app_user_tenant_id"`);
  }
}
