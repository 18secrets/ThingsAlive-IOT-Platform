import { MigrationInterface, QueryRunner } from 'typeorm';

/** New content checks share sensor row locks with retirement. Deletion is exposed
 * only through a narrow function: ta_app never receives general DELETE permission.
 * Its fixed search path and transaction-local bypass allow counts across tenants
 * without returning tenant content or changing the caller's RLS context. */
export class SensorContentGuards1758310000000 implements MigrationInterface {
  name = 'SensorContentGuards1758310000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION sensor_retirement_problems(signals jsonb) RETURNS text[]
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      DECLARE sig jsonb; s record; problems text[] := '{}'; retired text[]; live boolean;
      BEGIN
        FOR sig IN SELECT value FROM jsonb_array_elements(signals) LOOP
          retired := '{}'; live := false;
          FOR s IN SELECT DISTINCT sensor.* FROM sensor
            JOIN sensor_role_capability c ON c.sensor_id = sensor.id
            WHERE c.measurement_role = sig->>'signal'
              AND (c.canonical_unit IS NULL OR c.canonical_unit = sig->>'unit')
            ORDER BY sensor.id LOOP
            -- Re-read after acquiring the lock: retirement may have committed
            -- while the capability lookup above was running.
            SELECT * INTO s FROM sensor WHERE id = s.id FOR SHARE;
            IF s.retired_at IS NULL THEN live := true;
            ELSE retired := array_append(retired, format(
              'sensor "%s" (%s) was retired on %s and cannot be used on new content (sensor_retired).',
              s.sensor_name, s.slug, to_char(s.retired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')));
            END IF;
          END LOOP;
          IF NOT live THEN problems := problems || retired; END IF;
        END LOOP;
        RETURN problems;
      END $$`);
    await q.query(`CREATE FUNCTION ck_class_sensor_retirement() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      DECLARE signals jsonb; problems text[];
      BEGIN
        signals := NEW.expected_signals;
        IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'published' AND OLD.status <> 'published') THEN
          SELECT coalesce(jsonb_agg(s), '[]') INTO signals FROM jsonb_array_elements(signals) s
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.expected_signals) o
            WHERE o->>'signal' = s->>'signal' AND o->>'unit' IS NOT DISTINCT FROM s->>'unit');
        END IF;
        problems := sensor_retirement_problems(signals);
        IF cardinality(problems) > 0 THEN RAISE EXCEPTION '%', array_to_string(problems, ' '); END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_class_sensor_retirement BEFORE INSERT OR UPDATE OF expected_signals, status
      ON equipment_class_profile FOR EACH ROW EXECUTE FUNCTION ck_class_sensor_retirement()`);
    await q.query(`CREATE FUNCTION ck_new_sensor_reference() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      DECLARE s sensor; ref jsonb; refs jsonb;
      BEGIN
        IF TG_TABLE_NAME = 'sensor_role_capability' THEN
          IF TG_OP = 'UPDATE' AND NEW.sensor_id = OLD.sensor_id AND NEW.measurement_role = OLD.measurement_role
            AND NEW.parameter_key IS NOT DISTINCT FROM OLD.parameter_key
            AND NEW.canonical_unit IS NOT DISTINCT FROM OLD.canonical_unit THEN RETURN NEW; END IF;
          refs := jsonb_build_array(jsonb_build_object('sensorId', NEW.sensor_id));
        ELSE
          refs := NEW.mapped_sensors;
          IF TG_OP = 'UPDATE' THEN
            SELECT coalesce(jsonb_agg(r), '[]') INTO refs FROM jsonb_array_elements(refs) r
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.mapped_sensors) o
                WHERE o->>'sensorId' = r->>'sensorId');
          END IF;
        END IF;
        FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
          SELECT * INTO s FROM sensor WHERE id = (ref->>'sensorId')::uuid FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'No sensor "%" (sensor_reference).', ref->>'sensorId'; END IF;
          IF s.retired_at IS NOT NULL THEN RAISE EXCEPTION
            'sensor "%" (%) was retired on % and cannot be used on new content (sensor_retired).',
            s.sensor_name, s.slug, to_char(s.retired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'); END IF;
        END LOOP;
        RETURN NEW;
      END $$`);
    for (const table of ['sensor_role_capability', 'tool_mapping']) {
      await q.query(`CREATE TRIGGER trg_new_sensor_reference BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ck_new_sensor_reference()`);
    }

    await q.query(`CREATE FUNCTION ck_approved_sensor_reference() RETURNS trigger
      LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
      DECLARE d jsonb; found_id uuid;
      BEGIN
        FOR d IN SELECT value FROM jsonb_array_elements(NEW.sensor_decisions) LOOP
          IF d->>'decision' <> 'approved' THEN CONTINUE; END IF;
          IF TG_OP = 'UPDATE' AND OLD.sensor_decisions @> jsonb_build_array(d) THEN CONTINUE; END IF;
          IF d->>'kind' = 'sensor' THEN
            SELECT id INTO found_id FROM sensor WHERE slug = d->>'slug' FOR SHARE;
          ELSE
            SELECT id INTO found_id FROM sensor_category
              WHERE coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'sensor') = d->>'slug'
              FOR SHARE;
          END IF;
          IF NOT FOUND THEN RAISE EXCEPTION 'No % "%" for approval (sensor_reference).', d->>'kind', d->>'slug'; END IF;
        END LOOP;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_approved_sensor_reference BEFORE INSERT OR UPDATE OF sensor_decisions
      ON catalog_import_batch FOR EACH ROW EXECUTE FUNCTION ck_approved_sensor_reference()`);

    await q.query(`CREATE FUNCTION delete_unused_sensor(target uuid, category boolean DEFAULT false) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE s sensor; category_name text; refs jsonb; failures text;
      BEGIN
        -- JSON references have no FK. Serialize their writers with the check and
        -- delete; the mapping trigger also refuses a writer that resumes afterwards.
        -- EXCLUSIVE also waits for an import's SELECT FOR UPDATE before taking
        -- a sensor lock; otherwise that import's later batch UPDATE can deadlock.
        LOCK TABLE tool_mapping, catalog_import_batch IN EXCLUSIVE MODE;
        IF category THEN
          SELECT name INTO category_name FROM sensor_category WHERE id = target FOR UPDATE;
          IF NOT FOUND THEN RETURN false; END IF;
          SELECT jsonb_build_object('sensor', (SELECT count(*) FROM sensor WHERE category_id = target),
            'catalog_import_batch', (SELECT count(*) FROM catalog_import_batch b WHERE EXISTS
              (SELECT 1 FROM jsonb_array_elements(b.sensor_decisions) d WHERE d->>'kind' = 'category'
                AND d->>'decision' = 'approved' AND d->>'slug' = coalesce(nullif(trim(both '-' from regexp_replace(lower(category_name), '[^a-z0-9]+', '-', 'g')), ''), 'sensor')))) INTO refs;
        ELSE
          SELECT * INTO s FROM sensor WHERE id = target FOR UPDATE;
          IF NOT FOUND THEN RETURN false; END IF;
          SELECT jsonb_build_object(
            'equipment_class_profile', (SELECT count(*) FROM equipment_class_profile p WHERE EXISTS
              (SELECT 1 FROM jsonb_array_elements(p.expected_signals) e JOIN sensor_role_capability c
                ON c.measurement_role = e->>'signal' WHERE c.sensor_id = target)),
            'client_equipment_class', (SELECT count(*) FROM client_equipment_class p WHERE EXISTS
              (SELECT 1 FROM jsonb_array_elements(p.expected_signals) e JOIN sensor_role_capability c
                ON c.measurement_role = e->>'signal' WHERE c.sensor_id = target)),
            'signal_binding_version', (SELECT count(*) FROM signal_binding_version b JOIN sensor_instance i
              ON i.id = b.sensor_instance_id WHERE i.sensor_id = target),
            'sensor_instance', (SELECT count(*) FROM sensor_instance WHERE sensor_id = target),
            'sensor_role_capability', (SELECT count(*) FROM sensor_role_capability WHERE sensor_id = target),
            'tool_mapping', (SELECT count(*) FROM tool_mapping t WHERE EXISTS
              (SELECT 1 FROM jsonb_array_elements(t.mapped_sensors) r WHERE (r->>'sensorId')::uuid = target)),
            'catalog_import_batch', (SELECT count(*) FROM catalog_import_batch b WHERE EXISTS
              (SELECT 1 FROM jsonb_array_elements(b.sensor_decisions) d WHERE d->>'kind' = 'sensor'
                AND d->>'decision' = 'approved' AND d->>'slug' = s.slug))) INTO refs;
        END IF;
        SELECT string_agg(key || ': ' || value || ' row(s)', ', ' ORDER BY key) INTO failures
          FROM jsonb_each_text(refs) WHERE value::bigint > 0;
        IF failures IS NOT NULL THEN RAISE EXCEPTION 'Delete refused: % (sensor_referenced).', failures; END IF;
        IF category THEN DELETE FROM sensor_category WHERE id = target;
        ELSE DELETE FROM sensor WHERE id = target; END IF;
        RETURN true;
      END $$`);
    await q.query(`REVOKE ALL ON FUNCTION delete_unused_sensor(uuid, boolean) FROM PUBLIC`);
    await q.query(`GRANT EXECUTE ON FUNCTION delete_unused_sensor(uuid, boolean) TO ta_app`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION delete_unused_sensor(uuid, boolean)`);
    await q.query(`DROP TRIGGER trg_approved_sensor_reference ON catalog_import_batch`);
    await q.query(`DROP FUNCTION ck_approved_sensor_reference()`);
    for (const table of ['tool_mapping', 'sensor_role_capability']) {
      await q.query(`DROP TRIGGER trg_new_sensor_reference ON ${table}`);
    }
    await q.query(`DROP FUNCTION ck_new_sensor_reference()`);
    await q.query(`DROP TRIGGER trg_class_sensor_retirement ON equipment_class_profile`);
    await q.query(`DROP FUNCTION ck_class_sensor_retirement()`);
    await q.query(`DROP FUNCTION sensor_retirement_problems(jsonb)`);
  }
}
