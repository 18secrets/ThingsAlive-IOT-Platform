import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The 3-D tier of the twin (task QTWIN1): a GLB per class version beside the
 * schematic, and anchors with a position in model space.
 *
 * Not new tables. D38 keys anchors by asset, not by class, so the tier joins the key of
 * the tables QREC0c built: one visual per (class version, tier), one anchor per
 * (class version, tier, signal). Parallel tables would have been a second inventory
 * entry and a second copy path doing exactly what the first one does — the drift
 * QGRANT0 exists to stop. Every existing row is a schematic and stays one by default.
 *
 * A model anchor must lie inside its model's bounding box, and that rule is a trigger,
 * not a service check: a percentage can be a CHECK, a coordinate needs the box it sits
 * in. A tenant anchor marked `needs_recheck` is exempt — it is in the tray precisely
 * because the geometry may have moved out from under it (D39).
 *
 * Literal lists again, for the reason PageLayout1758200000000 gives: a committed
 * migration's meaning must not move when the code's lists do.
 */
const IMAGES = "'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'";
const MODELS = "'model/gltf-binary'";
const WIDGETS_BEFORE = "'kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'readiness_list', 'schematic', "
  + "'alert_list', 'work_order_list', 'service_due', 'failure_modes', 'recommendations', 'machine_list', "
  + "'parameter_list', 'forecast_chart'";
const WIDGETS_AFTER = `${WIDGETS_BEFORE}, 'twin_model'`;
const WIDGET_CHECKS: [string, string][] = [
  ['equipment_class_layout', 'ck_class_layout_widget_type'],
  ['client_equipment_class_layout', 'ck_client_layout_widget_type'],
  ['site_class_layout', 'ck_site_layout_widget_type'],
];
const BOUNDS = ['bounds_min_x', 'bounds_min_y', 'bounds_min_z', 'bounds_max_x', 'bounds_max_y', 'bounds_max_z'];

/** A schematic anchor has hotspots and no position; a model anchor the reverse. */
const POSITION_CHECK = `
  ("tier" = 'schematic' AND "hotspot_x" IS NOT NULL AND "hotspot_y" IS NOT NULL
     AND "pos_x" IS NULL AND "pos_y" IS NULL AND "pos_z" IS NULL)
  OR ("tier" = 'model' AND "hotspot_x" IS NULL AND "hotspot_y" IS NULL
     AND "pos_x" IS NOT NULL AND "pos_y" IS NOT NULL AND "pos_z" IS NOT NULL)`;

export class TwinModel1761400000000 implements MigrationInterface {
  name = 'TwinModel1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- the visual
    await q.query(`ALTER TABLE "equipment_class_visual_anchor" DROP CONSTRAINT "fk_class_anchor_visual"`);
    await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "uq_class_visual"`);
    await q.query(`ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "uq_class_visual" UNIQUE ("class_slug", "class_version", "tier")`);
    await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "ck_class_visual_tier"`);
    await q.query(`ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_tier" CHECK ("tier" IN ('schematic', 'model'))`);
    await q.query(`ALTER TABLE "equipment_class_visual" ADD COLUMN "geometry_version" int`);
    for (const c of BOUNDS) await q.query(`ALTER TABLE "equipment_class_visual" ADD COLUMN "${c}" numeric`);

    for (const col of ['content_type', 'pending_content_type']) {
      const name = col === 'content_type' ? 'ck_class_visual_content_type' : 'ck_class_visual_pending_content_type';
      await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "${name}"`);
      // A GLB is not a picture and a PNG is not a mesh: the type follows the tier.
      await q.query(`
        ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "${name}" CHECK (
          "${col}" IS NULL
          OR ("tier" = 'schematic' AND "${col}" IN (${IMAGES}))
          OR ("tier" = 'model' AND "${col}" IN (${MODELS})))`);
    }
    // A confirmed asset carries everything its renderer needs: an image its size, a model
    // its box and geometry version. Half of either is a broken twin.
    await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "ck_class_visual_confirmed"`);
    const allBounds = (isNull: boolean) => BOUNDS.map((c) => `"${c}" IS ${isNull ? '' : 'NOT '}NULL`).join(' AND ');
    await q.query(`
      ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_confirmed" CHECK (
        ("asset_key" IS NULL) = ("content_type" IS NULL)
        AND CASE WHEN "tier" = 'schematic' THEN
              ("asset_key" IS NULL) = ("width_px" IS NULL) AND ("asset_key" IS NULL) = ("height_px" IS NULL)
              AND "geometry_version" IS NULL AND ${allBounds(true)}
            ELSE
              "width_px" IS NULL AND "height_px" IS NULL
              AND ("asset_key" IS NULL) = ("geometry_version" IS NULL)
              AND (("asset_key" IS NULL AND ${allBounds(true)}) OR ("asset_key" IS NOT NULL AND ${allBounds(false)}))
            END)`);
    // Equal is allowed: a flat panel is a model too.
    await q.query(`
      ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_bounds" CHECK (
        "bounds_min_x" IS NULL OR ("bounds_min_x" <= "bounds_max_x" AND "bounds_min_y" <= "bounds_max_y" AND "bounds_min_z" <= "bounds_max_z"))`);
    await q.query(`
      ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_geometry_version" CHECK (
        "geometry_version" IS NULL OR "geometry_version" >= 1)`);

    // ------------------------------------------------------- the platform anchors
    await this.anchorColumns(q, 'equipment_class_visual_anchor', 'ck_class_anchor');
    await q.query(`ALTER TABLE "equipment_class_visual_anchor" DROP CONSTRAINT "uq_class_anchor_signal"`);
    await q.query(`
      ALTER TABLE "equipment_class_visual_anchor" ADD CONSTRAINT "uq_class_anchor_signal"
        UNIQUE ("class_slug", "class_version", "tier", "signal")`);
    // An anchor on a class with no visual of its tier has nothing to sit on.
    await q.query(`
      ALTER TABLE "equipment_class_visual_anchor" ADD CONSTRAINT "fk_class_anchor_visual"
        FOREIGN KEY ("class_slug", "class_version", "tier")
        REFERENCES "equipment_class_visual" ("class_slug", "class_version", "tier")`);

    // One check for both tables: the model this anchor is placed on, by class version.
    await q.query(`
      CREATE FUNCTION "ck_model_anchor_fits"(slug text, version int, signal text, x numeric, y numeric, z numeric, rule text)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE m record;
      BEGIN
        SELECT * INTO m FROM "equipment_class_visual" v
         WHERE v."class_slug" = slug AND v."class_version" = version AND v."tier" = 'model';
        IF NOT FOUND OR m."asset_key" IS NULL THEN
          RAISE EXCEPTION '%: anchor for "%" needs a confirmed model to sit on; "%" v% has none.', rule, signal, slug, version
            USING ERRCODE = 'check_violation', CONSTRAINT = rule;
        END IF;
        IF x < m."bounds_min_x" OR x > m."bounds_max_x" OR y < m."bounds_min_y" OR y > m."bounds_max_y"
           OR z < m."bounds_min_z" OR z > m."bounds_max_z" THEN
          RAISE EXCEPTION '%: anchor for "%" at (%, %, %) is outside the model''s bounds (% to %, % to %, % to %).',
            rule, signal, x, y, z, m."bounds_min_x", m."bounds_max_x", m."bounds_min_y", m."bounds_max_y",
            m."bounds_min_z", m."bounds_max_z"
            USING ERRCODE = 'check_violation', CONSTRAINT = rule;
        END IF;
      END $$`);
    await q.query(`
      CREATE FUNCTION "trg_class_anchor_fits"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."tier" = 'model' THEN
          PERFORM "ck_model_anchor_fits"(NEW."class_slug", NEW."class_version", NEW."signal",
            NEW."pos_x", NEW."pos_y", NEW."pos_z", 'ck_class_anchor_fits');
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_equipment_class_visual_anchor_fits"
        BEFORE INSERT OR UPDATE ON "equipment_class_visual_anchor"
        FOR EACH ROW EXECUTE FUNCTION "trg_class_anchor_fits"()`);

    // --------------------------------------------------------- the tenant anchors
    await this.anchorColumns(q, 'client_equipment_class_visual_anchor', 'ck_client_anchor');
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" DROP CONSTRAINT "uq_client_anchor_signal"`);
    await q.query(`
      ALTER TABLE "client_equipment_class_visual_anchor" ADD CONSTRAINT "uq_client_anchor_signal"
        UNIQUE ("tenant_id", "client_equipment_class_slug", "tier", "signal")`);
    // Checked against the model of the version the row was written for, not the version
    // the class row says today: an upgrade writes the anchors before it moves the class
    // row on, and must be checked against the geometry it is moving to.
    await q.query(`
      CREATE FUNCTION "trg_client_anchor_fits"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE template text;
      BEGIN
        IF NEW."tier" <> 'model' OR NEW."needs_recheck" THEN RETURN NEW; END IF;
        SELECT c."template_slug" INTO template FROM "client_equipment_class" c
         WHERE c."tenant_id" = NEW."tenant_id" AND c."slug" = NEW."client_equipment_class_slug";
        IF template IS NULL OR NEW."template_version" IS NULL THEN
          RAISE EXCEPTION 'ck_client_anchor_fits: anchor for "%" names no class version to place it on.', NEW."signal"
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_client_anchor_fits';
        END IF;
        PERFORM "ck_model_anchor_fits"(template, NEW."template_version", NEW."signal",
          NEW."pos_x", NEW."pos_y", NEW."pos_z", 'ck_client_anchor_fits');
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_client_equipment_class_visual_anchor_fits"
        BEFORE INSERT OR UPDATE ON "client_equipment_class_visual_anchor"
        FOR EACH ROW EXECUTE FUNCTION "trg_client_anchor_fits"()`);

    // ------------------------------------------------------------- the widget
    for (const [table, constraint] of WIDGET_CHECKS) await this.widgets(q, table, constraint, WIDGETS_AFTER);
  }

  /**
   * Down refuses while any model row exists — the restored constraints admit none.
   * Removing a tier a twin is showing is a decision, not a rollback.
   */
  public async down(q: QueryRunner): Promise<void> {
    for (const [table, constraint] of WIDGET_CHECKS) await this.widgets(q, table, constraint, WIDGETS_BEFORE);

    await q.query(`DROP TRIGGER IF EXISTS "trg_client_equipment_class_visual_anchor_fits" ON "client_equipment_class_visual_anchor"`);
    await q.query(`DROP FUNCTION IF EXISTS "trg_client_anchor_fits"()`);
    await q.query(`ALTER TABLE "client_equipment_class_visual_anchor" DROP CONSTRAINT "uq_client_anchor_signal"`);
    await q.query(`
      ALTER TABLE "client_equipment_class_visual_anchor" ADD CONSTRAINT "uq_client_anchor_signal"
        UNIQUE ("tenant_id", "client_equipment_class_slug", "signal")`);
    await this.dropAnchorColumns(q, 'client_equipment_class_visual_anchor', 'ck_client_anchor');

    await q.query(`DROP TRIGGER IF EXISTS "trg_equipment_class_visual_anchor_fits" ON "equipment_class_visual_anchor"`);
    await q.query(`DROP FUNCTION IF EXISTS "trg_class_anchor_fits"()`);
    await q.query(`DROP FUNCTION IF EXISTS "ck_model_anchor_fits"(text, int, text, numeric, numeric, numeric, text)`);
    await q.query(`ALTER TABLE "equipment_class_visual_anchor" DROP CONSTRAINT "fk_class_anchor_visual"`);
    await q.query(`ALTER TABLE "equipment_class_visual_anchor" DROP CONSTRAINT "uq_class_anchor_signal"`);
    await q.query(`
      ALTER TABLE "equipment_class_visual_anchor" ADD CONSTRAINT "uq_class_anchor_signal"
        UNIQUE ("class_slug", "class_version", "signal")`);
    await this.dropAnchorColumns(q, 'equipment_class_visual_anchor', 'ck_class_anchor');

    for (const name of ['ck_class_visual_geometry_version', 'ck_class_visual_bounds', 'ck_class_visual_confirmed']) {
      await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "${name}"`);
    }
    await q.query(`
      ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_confirmed"
        CHECK (("asset_key" IS NULL) = ("content_type" IS NULL)
           AND ("asset_key" IS NULL) = ("width_px" IS NULL)
           AND ("asset_key" IS NULL) = ("height_px" IS NULL))`);
    for (const col of ['content_type', 'pending_content_type']) {
      const name = col === 'content_type' ? 'ck_class_visual_content_type' : 'ck_class_visual_pending_content_type';
      await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "${name}"`);
      await q.query(`ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "${name}" CHECK ("${col}" IS NULL OR "${col}" IN (${IMAGES}))`);
    }
    for (const c of [...BOUNDS, 'geometry_version']) await q.query(`ALTER TABLE "equipment_class_visual" DROP COLUMN "${c}"`);
    await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "ck_class_visual_tier"`);
    await q.query(`ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "ck_class_visual_tier" CHECK ("tier" IN ('schematic'))`);
    await q.query(`ALTER TABLE "equipment_class_visual" DROP CONSTRAINT "uq_class_visual"`);
    await q.query(`ALTER TABLE "equipment_class_visual" ADD CONSTRAINT "uq_class_visual" UNIQUE ("class_slug", "class_version")`);
    await q.query(`
      ALTER TABLE "equipment_class_visual_anchor" ADD CONSTRAINT "fk_class_anchor_visual"
        FOREIGN KEY ("class_slug", "class_version") REFERENCES "equipment_class_visual" ("class_slug", "class_version")`);
  }

  private async anchorColumns(q: QueryRunner, table: string, prefix: string): Promise<void> {
    await q.query(`ALTER TABLE "${table}" ADD COLUMN "tier" text NOT NULL DEFAULT 'schematic'`);
    await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${prefix}_tier" CHECK ("tier" IN ('schematic', 'model'))`);
    // Model units, not percentages: the box they must sit in is the model's, checked by trigger.
    for (const c of ['pos_x', 'pos_y', 'pos_z']) await q.query(`ALTER TABLE "${table}" ADD COLUMN "${c}" numeric`);
    await q.query(`ALTER TABLE "${table}" ALTER COLUMN "hotspot_x" DROP NOT NULL`);
    await q.query(`ALTER TABLE "${table}" ALTER COLUMN "hotspot_y" DROP NOT NULL`);
    await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${prefix}_position" CHECK (${POSITION_CHECK})`);
  }

  private async dropAnchorColumns(q: QueryRunner, table: string, prefix: string): Promise<void> {
    await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${prefix}_position"`);
    await q.query(`ALTER TABLE "${table}" ALTER COLUMN "hotspot_x" SET NOT NULL`);
    await q.query(`ALTER TABLE "${table}" ALTER COLUMN "hotspot_y" SET NOT NULL`);
    for (const c of ['pos_x', 'pos_y', 'pos_z']) await q.query(`ALTER TABLE "${table}" DROP COLUMN "${c}"`);
    await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${prefix}_tier"`);
    await q.query(`ALTER TABLE "${table}" DROP COLUMN "tier"`);
  }

  private async widgets(q: QueryRunner, table: string, constraint: string, types: string): Promise<void> {
    await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
    await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK ("widget_type" IN (${types}))`);
  }
}
