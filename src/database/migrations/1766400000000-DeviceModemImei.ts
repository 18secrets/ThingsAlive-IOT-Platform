import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The cellular modem's IMEI, kept beside a device's own identifier.
 *
 * `device_inventory.imei` is not always an IMEI. A motor logger names itself in firmware
 * (`MOTOR_001`), and every upload is matched to its device by that name — so the name has
 * to stay in `imei`, and the modem's real number needs somewhere else to live. Writing it
 * into `imei` instead would cut the logger off from its machine on the next upload.
 *
 * Both rules are here rather than in the service: fifteen digits with a valid check digit,
 * because a mistyped IMEI is the usual way a SIM ticket goes to the wrong modem; and one
 * device per modem, because two rows naming one modem is one piece of hardware in two
 * places, and two concurrent edits would each pass a service-side lookup.
 */
export class DeviceModemImei1766400000000 implements MigrationInterface {
  name = 'DeviceModemImei1766400000000';

  public async up(q: QueryRunner): Promise<void> {
    // Luhn, counting i from the rightmost digit (the check digit, i = 0): every second
    // digit leftward is doubled. IMMUTABLE so a CHECK may use it. The outer CASE, not AND,
    // because SQL does not promise to test the shape first, and '12a'::int would raise.
    await q.query(`CREATE FUNCTION imei_check_digit_ok(v text) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT CASE WHEN v !~ '^[0-9]{15}$' THEN false ELSE (
          SELECT sum(CASE WHEN i % 2 = 1
                          THEN (substr(v, 15 - i, 1)::int * 2) / 10 + (substr(v, 15 - i, 1)::int * 2) % 10
                          ELSE substr(v, 15 - i, 1)::int END)
            FROM generate_series(0, 14) i
        ) % 10 = 0 END
      $$`);
    await q.query(`ALTER TABLE "device_inventory" ADD COLUMN "modem_imei" text`);
    await q.query(`ALTER TABLE "device_inventory" ADD CONSTRAINT "ck_device_inventory_modem_imei"
      CHECK ("modem_imei" IS NULL OR imei_check_digit_ok("modem_imei"))`);
    await q.query(`CREATE UNIQUE INDEX "uq_device_inventory_modem_imei" ON "device_inventory" ("modem_imei")
      WHERE "modem_imei" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "uq_device_inventory_modem_imei"`);
    await q.query(`ALTER TABLE "device_inventory" DROP COLUMN "modem_imei"`);
    await q.query(`DROP FUNCTION imei_check_digit_ok(text)`);
  }
}
