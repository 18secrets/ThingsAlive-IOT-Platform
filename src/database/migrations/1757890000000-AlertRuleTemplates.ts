import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alert rules become catalog content, copied on grant (task P1-128).
 *
 * Alerting shipped client-authored, which is right about who decides and wrong about
 * who starts. Every new account began with an empty rules list and had to already know
 * that a diesel generator's coolant matters at 103 °C well before the 110 °C alarm the
 * manufacturer stamped on it. That is the product, not the customer's homework, and it
 * belongs in the catalog with everything else Things Alive knows about the class.
 *
 * Three things happen here.
 *
 * `alert_rule_template` is the template side: platform-owned, versioned, published or
 * draft, exactly like the class and scenario tables it sits beside. No `tenant_id`,
 * because it belongs to nobody in particular until it is granted.
 *
 * `alert_rule` grows the same provenance columns the client catalog already carries, so
 * a rule can say where it came from. A rule with no `template_slug` is one the client
 * wrote themselves, and that distinction is what lets a screen show "from template",
 * "edited" and "yours" as three different things instead of one undifferentiated list.
 *
 * And `applies_to` grows a fourth value. A template is authored against a class and
 * knows no plant and no machine; without `equipment-class` scoping, a rule written for
 * generators would land in the account watching the air compressors too — firing on
 * machines it was never about, which is the fastest way to teach a new customer that
 * our alerts are noise.
 */
export class AlertRuleTemplates1757890000000 implements MigrationInterface {
  name = 'AlertRuleTemplates1757890000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "alert_rule_template" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "equipment_class_slug" text NOT NULL,
        "name" text NOT NULL,
        "description" text,
        "trigger" text NOT NULL,
        "params" jsonb NOT NULL,
        "severity" text NOT NULL DEFAULT 'high',
        "enabled_on_copy" boolean NOT NULL DEFAULT true,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "created_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE UNIQUE INDEX "uq_alert_rule_template_version"
        ON "alert_rule_template" ("slug", "version")`);
    await q.query(`
      CREATE INDEX "ix_alert_rule_template_class"
        ON "alert_rule_template" ("equipment_class_slug")`);
    await q.query(`
      CREATE INDEX "ix_alert_rule_template_status"
        ON "alert_rule_template" ("status")`);

    await q.query(`
      ALTER TABLE "alert_rule_template" ADD CONSTRAINT "ck_alert_rule_template_status"
        CHECK ("status" IN ('draft', 'published', 'retired'))`);
    // The same five triggers the rules themselves allow. Two lists that must agree are
    // a bug waiting to happen, but a template that could carry a trigger the runtime
    // cannot evaluate would copy into an account and never fire, silently.
    await q.query(`
      ALTER TABLE "alert_rule_template" ADD CONSTRAINT "ck_alert_rule_template_trigger"
        CHECK ("trigger" IN (
          'prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss',
          'chain-origin'
        ))`);

    // SELECT, INSERT and UPDATE, matching the other template tables. No DELETE: a
    // published template is what some account's rules record as their origin, and
    // deleting it would turn that record into a dangling reference nobody can resolve
    // when they ask why a customer's rule says what it says. Retiring is the way out.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "alert_rule_template" TO "ta_app"`);

    // --- The copy side ------------------------------------------------------------
    await q.query(`ALTER TABLE "alert_rule" ADD COLUMN "template_slug" text`);
    await q.query(`ALTER TABLE "alert_rule" ADD COLUMN "template_version" int`);
    await q.query(`ALTER TABLE "alert_rule" ADD COLUMN "template_checksum" text`);
    await q.query(`ALTER TABLE "alert_rule" ADD COLUMN "copied_at" timestamptz`);
    await q.query(`ALTER TABLE "alert_rule" ADD COLUMN "equipment_class_slug" text`);

    await q.query(`
      CREATE INDEX "ix_alert_rule_template" ON "alert_rule" ("tenant_id", "template_slug")`);

    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_applies"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_applies"
        CHECK ("applies_to" IN ('account', 'plant', 'equipment', 'equipment-class'))`);

    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_scope"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_scope"
        CHECK (
          ("applies_to" = 'account')
          OR ("applies_to" = 'plant' AND "plant_id" IS NOT NULL)
          OR ("applies_to" = 'equipment' AND "source_system" IS NOT NULL AND "external_id" IS NOT NULL)
          OR ("applies_to" = 'equipment-class' AND "equipment_class_slug" IS NOT NULL)
        )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Rules of the new shape have to go before the old constraints can hold again.
    // They are copies, so re-granting the class reproduces them; a client's own edits
    // to them do not survive, which is why this path is a rollback rather than a
    // migration anybody should run on a whim.
    await q.query(`DELETE FROM "alert_rule" WHERE "applies_to" = 'equipment-class'`);

    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_scope"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_scope"
        CHECK (
          ("applies_to" = 'account')
          OR ("applies_to" = 'plant' AND "plant_id" IS NOT NULL)
          OR ("applies_to" = 'equipment' AND "source_system" IS NOT NULL AND "external_id" IS NOT NULL)
        )`);

    await q.query(`ALTER TABLE "alert_rule" DROP CONSTRAINT "ck_alert_rule_applies"`);
    await q.query(`
      ALTER TABLE "alert_rule" ADD CONSTRAINT "ck_alert_rule_applies"
        CHECK ("applies_to" IN ('account', 'plant', 'equipment'))`);

    await q.query(`DROP INDEX "ix_alert_rule_template"`);
    await q.query(`ALTER TABLE "alert_rule" DROP COLUMN "equipment_class_slug"`);
    await q.query(`ALTER TABLE "alert_rule" DROP COLUMN "copied_at"`);
    await q.query(`ALTER TABLE "alert_rule" DROP COLUMN "template_checksum"`);
    await q.query(`ALTER TABLE "alert_rule" DROP COLUMN "template_version"`);
    await q.query(`ALTER TABLE "alert_rule" DROP COLUMN "template_slug"`);

    await q.query(`REVOKE ALL ON "alert_rule_template" FROM "ta_app"`);
    await q.query(`DROP TABLE "alert_rule_template"`);
  }
}
