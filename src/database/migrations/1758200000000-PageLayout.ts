import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Page layout as library content, and the site class (task QREC0b, D30 part 3).
 *
 * A widget type is code (src/catalog/layout/widget-types.ts); which widgets a page
 * shows, in what order and bound to what, is a row — authored, published, immutable,
 * copied on grant. The CHECK on widget_type restates the code's list so the database
 * refuses a type no renderer exists for; test/page-layout.spec.ts fails if the two
 * ever drift.
 *
 * Nothing here is backfilled. A class with no layout rows is valid and gets a
 * computed fallback (layout-rules.ts), so no existing class needed a layout authored
 * for this migration to apply.
 */
export class PageLayout1758200000000 implements MigrationInterface {
  name = 'PageLayout1758200000000';

  public async up(q: QueryRunner): Promise<void> {
    // Literal, not imported from widget-types.ts: a committed migration must create the
    // same schema forever, and an imported list would change what this one creates the
    // day a type is added. Adding a type is a new migration that alters this CHECK.
    const types = "'kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'readiness_list', 'schematic', "
      + "'alert_list', 'work_order_list', 'service_due', 'failure_modes', 'recommendations', 'machine_list'";
    const sizes = "'small', 'medium', 'large', 'full'";

    // ------------------------------------------------------- equipment class layout
    await q.query(`
      CREATE TABLE "equipment_class_layout" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "widget_type" text NOT NULL,
        "widget_key" text NOT NULL,
        "bound_to" text,
        "title" text,
        "position" int NOT NULL,
        "size" text NOT NULL,
        "source" text NOT NULL DEFAULT 'manual',
        "import_batch_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_class_layout_class"
          FOREIGN KEY ("class_slug", "class_version")
          REFERENCES "equipment_class_profile" ("slug", "version"),
        CONSTRAINT "ck_class_layout_widget_type" CHECK ("widget_type" IN (${types})),
        CONSTRAINT "ck_class_layout_size" CHECK ("size" IN (${sizes})),
        CONSTRAINT "ck_class_layout_position" CHECK ("position" > 0),
        CONSTRAINT "ck_class_layout_source" CHECK ("source" IN ('manual', 'excel-import')),
        CONSTRAINT "uq_class_layout_key" UNIQUE ("class_slug", "class_version", "widget_key"),
        -- Two widgets at one position is a page nobody can render deterministically.
        CONSTRAINT "uq_class_layout_position" UNIQUE ("class_slug", "class_version", "position")
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "equipment_class_layout" TO "ta_app"`);
    // The same rule QREC0a put on failure modes: a published version's content does
    // not change, and the database refuses it rather than trusting every path to.
    await q.query(`
      CREATE TRIGGER "trg_equipment_class_layout_draft_only"
        BEFORE UPDATE OR DELETE ON "equipment_class_layout"
        FOR EACH ROW EXECUTE FUNCTION "ck_class_content_draft_only"()`);

    // ------------------------------------------------------------ tenant layout copy
    // The tenant may hide a widget and reorder; nothing else. The position constraint
    // is deferrable because a reorder is a permutation, and swapping two positions one
    // row at a time passes through a state where both rows hold the same number.
    await q.query(`
      CREATE TABLE "client_equipment_class_layout" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "widget_type" text NOT NULL,
        "widget_key" text NOT NULL,
        "bound_to" text,
        "title" text,
        "position" int NOT NULL,
        "size" text NOT NULL,
        "hidden" boolean NOT NULL DEFAULT false,
        "position_custom" boolean NOT NULL DEFAULT false,
        "template_version" int,
        "copied_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_client_layout_widget_type" CHECK ("widget_type" IN (${types})),
        CONSTRAINT "ck_client_layout_size" CHECK ("size" IN (${sizes})),
        CONSTRAINT "ck_client_layout_position" CHECK ("position" > 0),
        CONSTRAINT "uq_client_layout_key" UNIQUE ("tenant_id", "client_equipment_class_slug", "widget_key"),
        CONSTRAINT "uq_client_layout_position" UNIQUE ("tenant_id", "client_equipment_class_slug", "position")
          DEFERRABLE INITIALLY DEFERRED
      )`);
    await q.query(`ALTER TABLE "client_equipment_class_layout" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_equipment_class_layout" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_equipment_class_layout"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_equipment_class_layout" TO "ta_app"`);

    // ------------------------------------------------------------------- site class
    // Same lifecycle as equipment_class_profile. Platform-owned and read directly —
    // nothing grants a site class to a tenant, so nothing copies one.
    await q.query(`
      CREATE TABLE "site_class" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "name" text NOT NULL,
        "description" text,
        "status" text NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "created_by" text,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_site_class_status" CHECK ("status" IN ('draft', 'published', 'retired')),
        CONSTRAINT "uq_site_class_version" UNIQUE ("slug", "version")
      )`);
    await q.query(`
      CREATE TABLE "site_class_layout" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "site_class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "widget_type" text NOT NULL,
        "widget_key" text NOT NULL,
        "bound_to" text,
        "title" text,
        "position" int NOT NULL,
        "size" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_site_layout_class"
          FOREIGN KEY ("site_class_slug", "class_version") REFERENCES "site_class" ("slug", "version"),
        CONSTRAINT "ck_site_layout_widget_type" CHECK ("widget_type" IN (${types})),
        CONSTRAINT "ck_site_layout_size" CHECK ("size" IN (${sizes})),
        CONSTRAINT "ck_site_layout_position" CHECK ("position" > 0),
        CONSTRAINT "uq_site_layout_key" UNIQUE ("site_class_slug", "class_version", "widget_key"),
        CONSTRAINT "uq_site_layout_position" UNIQUE ("site_class_slug", "class_version", "position")
      )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "site_class" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "site_class_layout" TO "ta_app"`);

    // The platform default, which every plant with no site class of its own resolves
    // to. Seeded here because nothing else can create one: there are deliberately no
    // authoring routes for site classes until a second one is wanted.
    await q.query(`
      INSERT INTO "site_class" ("slug", "version", "name", "description", "status", "published_at", "created_by")
        VALUES ('default', 1, 'Site', 'The platform default site page: its machines, its alerts, its work.',
                'published', now(), 'migration:PageLayout1758200000000')`);
    await q.query(`
      INSERT INTO "site_class_layout" ("site_class_slug", "class_version", "widget_type", "widget_key", "position", "size")
        VALUES ('default', 1, 'machine_list', 'machines', 1, 'full'),
               ('default', 1, 'alert_list', 'alerts', 2, 'medium'),
               ('default', 1, 'work_order_list', 'work_orders', 3, 'medium')`);

    // ----------------------------------------------------------------- plant -> site
    // Both nullable, and NULL means the default above. Required would have asked every
    // existing plant for a value it has no basis for.
    await q.query(`ALTER TABLE "plant" ADD COLUMN "site_class_slug" text`);
    await q.query(`ALTER TABLE "plant" ADD COLUMN "site_class_version" int`);
    await q.query(`
      ALTER TABLE "plant" ADD CONSTRAINT "ck_plant_site_class_pair"
        CHECK (("site_class_slug" IS NULL) = ("site_class_version" IS NULL))`);
    await q.query(`
      ALTER TABLE "plant" ADD CONSTRAINT "fk_plant_site_class"
        FOREIGN KEY ("site_class_slug", "site_class_version") REFERENCES "site_class" ("slug", "version")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "plant" DROP CONSTRAINT IF EXISTS "fk_plant_site_class"`);
    await q.query(`ALTER TABLE "plant" DROP CONSTRAINT IF EXISTS "ck_plant_site_class_pair"`);
    await q.query(`ALTER TABLE "plant" DROP COLUMN IF EXISTS "site_class_version"`);
    await q.query(`ALTER TABLE "plant" DROP COLUMN IF EXISTS "site_class_slug"`);
    await q.query(`DROP TABLE IF EXISTS "site_class_layout"`);
    await q.query(`DROP TABLE IF EXISTS "site_class"`);
    await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "client_equipment_class_layout"`);
    await q.query(`DROP TABLE IF EXISTS "client_equipment_class_layout"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_layout"`);
  }
}
