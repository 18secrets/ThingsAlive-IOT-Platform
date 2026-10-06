import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Class visuals — tier 0, the schematic — and their anchors (task QREC0c).
 *
 * The bytes are never here: `asset_key` names an object in an S3-compatible bucket.
 * The image is platform-owned and shared by every tenant with the class, so there is
 * no tenant copy of `equipment_class_visual`; the anchor set is rows, is copied on
 * grant, and is the part a tenant changes.
 *
 * An upload is two steps. Issuing the presigned URL records only `pending_key`;
 * `asset_key` is set by the confirm call, after the object has been checked to exist.
 * A key recorded at issuance would be a row pointing at nothing the moment an upload
 * failed, and nothing would ever notice.
 */
export class ClassVisuals1758400000000 implements MigrationInterface {
  name = 'ClassVisuals1758400000000';

  public async up(q: QueryRunner): Promise<void> {
    // Literal, not imported — a committed migration's meaning must not move when the
    // code's list does (QREC0b's reasoning for widget types).
    const contentTypes = "'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'";

    await q.query(`
      CREATE TABLE "equipment_class_visual" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "tier" text NOT NULL DEFAULT 'schematic',
        "asset_key" text,
        "content_type" text,
        "width_px" int,
        "height_px" int,
        "size_bytes" bigint,
        "pending_key" text,
        "pending_content_type" text,
        "uploaded_by" text,
        "uploaded_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_class_visual_class"
          FOREIGN KEY ("class_slug", "class_version") REFERENCES "equipment_class_profile" ("slug", "version"),
        -- Tier 0 only, for now. The 3-D tier is QTWIN1 and adds its value here.
        CONSTRAINT "ck_class_visual_tier" CHECK ("tier" IN ('schematic')),
        CONSTRAINT "ck_class_visual_content_type"
          CHECK ("content_type" IS NULL OR "content_type" IN (${contentTypes})),
        CONSTRAINT "ck_class_visual_pending_content_type"
          CHECK ("pending_content_type" IS NULL OR "pending_content_type" IN (${contentTypes})),
        -- A confirmed asset carries everything a renderer needs; half of it is a broken image.
        CONSTRAINT "ck_class_visual_confirmed"
          CHECK (("asset_key" IS NULL) = ("content_type" IS NULL)
             AND ("asset_key" IS NULL) = ("width_px" IS NULL)
             AND ("asset_key" IS NULL) = ("height_px" IS NULL)),
        CONSTRAINT "ck_class_visual_dimensions" CHECK ("width_px" IS NULL OR ("width_px" > 0 AND "height_px" > 0)),
        -- One visual per class version.
        CONSTRAINT "uq_class_visual" UNIQUE ("class_slug", "class_version")
      )`);

    await q.query(`
      CREATE TABLE "equipment_class_visual_anchor" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "class_slug" text NOT NULL,
        "class_version" int NOT NULL,
        "signal" text NOT NULL,
        -- Percentages: resolution-independent, so a replaced image keeps its markers.
        "hotspot_x" numeric NOT NULL,
        "hotspot_y" numeric NOT NULL,
        "label" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_class_anchor_x" CHECK ("hotspot_x" >= 0 AND "hotspot_x" <= 100),
        CONSTRAINT "ck_class_anchor_y" CHECK ("hotspot_y" >= 0 AND "hotspot_y" <= 100),
        CONSTRAINT "uq_class_anchor_signal" UNIQUE ("class_slug", "class_version", "signal"),
        -- An anchor on a class with no visual row has nothing to sit on.
        CONSTRAINT "fk_class_anchor_visual"
          FOREIGN KEY ("class_slug", "class_version") REFERENCES "equipment_class_visual" ("class_slug", "class_version")
      )`);

    for (const table of ['equipment_class_visual', 'equipment_class_visual_anchor']) {
      await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "ta_app"`);
      // Published content does not change (QREC0a's trigger, reused).
      await q.query(`
        CREATE TRIGGER "trg_${table}_draft_only"
          BEFORE UPDATE OR DELETE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "ck_class_content_draft_only"()`);
    }

    await q.query(`
      CREATE TABLE "client_equipment_class_visual_anchor" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "client_equipment_class_slug" text NOT NULL,
        "signal" text NOT NULL,
        "hotspot_x" numeric NOT NULL,
        "hotspot_y" numeric NOT NULL,
        "label" text,
        -- Set when the tenant moved or added it: a marker somebody deliberately
        -- positioned is never moved by a new class version.
        "placement_custom" boolean NOT NULL DEFAULT false,
        "template_version" int,
        "copied_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_client_anchor_x" CHECK ("hotspot_x" >= 0 AND "hotspot_x" <= 100),
        CONSTRAINT "ck_client_anchor_y" CHECK ("hotspot_y" >= 0 AND "hotspot_y" <= 100),
        CONSTRAINT "uq_client_anchor_signal" UNIQUE ("tenant_id", "client_equipment_class_slug", "signal")
      )`);
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "client_equipment_class_visual_anchor"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "client_equipment_class_visual_anchor" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS "tenant_isolation" ON "client_equipment_class_visual_anchor"`);
    await q.query(`DROP TABLE IF EXISTS "client_equipment_class_visual_anchor"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_visual_anchor"`);
    await q.query(`DROP TABLE IF EXISTS "equipment_class_visual"`);
  }
}
