import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correcting a mistyped IMEI (testing sheet TC_152).
 *
 * The edit form showed the IMEI as a heading, so a typo at registration could only be
 * fixed by retiring the device and registering it again, which leaves a retired ghost
 * under the wrong number. The IMEI is how a device's telemetry finds it, though: once it
 * has been assigned, fitted or bound, readings and bindings already name that IMEI, and
 * changing it would quietly cut the device off from its own history. So it may change
 * only while the device has never been anywhere — in stock, in nobody's account, with no
 * movement but its registration and no binding. That rule is here, on the row, rather
 * than in the service alone: an assign racing the correction takes the same row lock,
 * and whichever goes second sees the other's state.
 *
 * `device_inventory_event` stays append-only (`ta_app` holds no UPDATE on it), so the
 * registration is not re-keyed. The correction is its own event under the new IMEI,
 * naming the one it replaced in `previous_imei`, and a device's history follows that
 * link back.
 */
export class ImeiCorrection1764500000000 implements MigrationInterface {
  name = 'ImeiCorrection1764500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "device_inventory_event" ADD COLUMN "previous_imei" text`);

    await q.query(`CREATE FUNCTION guard_imei_correction() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      BEGIN
        IF btrim(NEW.imei) = '' THEN
          RAISE EXCEPTION 'An IMEI cannot be blank.'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_imei_fixed_once_used';
        END IF;
        IF OLD.state <> 'in-stock' OR OLD.tenant_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM device_inventory_event e
                       WHERE e.imei = OLD.imei AND e.action NOT IN ('register', 'correct-imei'))
           OR EXISTS (SELECT 1 FROM signal_binding_version b WHERE b.imei = OLD.imei) THEN
          RAISE EXCEPTION 'Device % has left stock or been bound, so its IMEI is fixed: its readings already name it.', OLD.imei
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_imei_fixed_once_used';
        END IF;
        RETURN NEW;
      END $$`);

    await q.query(`CREATE TRIGGER trg_guard_imei_correction
      BEFORE UPDATE OF imei ON device_inventory
      FOR EACH ROW WHEN (NEW.imei IS DISTINCT FROM OLD.imei)
      EXECUTE FUNCTION guard_imei_correction()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER trg_guard_imei_correction ON device_inventory`);
    await q.query(`DROP FUNCTION guard_imei_correction()`);
    await q.query(`ALTER TABLE "device_inventory_event" DROP COLUMN "previous_imei"`);
  }
}
