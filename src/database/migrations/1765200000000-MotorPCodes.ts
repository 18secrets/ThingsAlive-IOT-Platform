import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The pump logger's fault codes (P-codes) become fault codes a machine page shows, in the
 * same episodes and the same panel as a vehicle's DTCs (16 Nov 2026).
 *
 * The logger raises six codes itself, but only over Bluetooth to the mobile app: its
 * HTTP upload carries readings and no codes. 2.0 therefore derives the same six from the
 * readings, by the device's own rules (Motor Logger Bluetooth API guide, 30 Oct 2026),
 * and files them under their own protocol. `pcode`, not `obd2`: an OBD-II P-code is four
 * digits (P0101) and means something else entirely, and 1.0's master sync writes obd2
 * rows keyed by exactly that text — sharing the protocol would let the two overwrite each
 * other's meaning.
 *
 * Titles, causes and fixes are the hardware team's (Pump Fault Code (P-code) Reference,
 * 30 Oct 2026). Severity and lamp follow the guide's warning/critical the way 1.0's
 * master sync maps a lamp: amber is high, red is critical.
 */
const CODES: readonly [code: string, description: string, lamp: string, severity: string, causes: string, remedies: string][] = [
  ['P101', 'Low voltage', 'amber_warning', 'high',
    'Weak grid, rural line or overloaded transformer: supply below about 190 V on a 230 V pump',
    'Fit a voltage stabiliser or a starter with low-voltage cutoff; run at off-peak hours'],
  ['P102', 'High voltage', 'amber_warning', 'high',
    'Grid surge or light-load hours: supply above about 250 V',
    'Fit a stabiliser or an over-voltage cutoff relay'],
  ['P207', 'Winding overheating', 'red_stop', 'critical',
    'Overload, poor cooling or voltage problems: motor body above about 70 °C',
    'Check cooling, load and winding; correct load and supply; let the motor cool'],
  ['P401', 'Dry run', 'red_stop', 'critical',
    'No water at the source, or the pump sits above the water level: running current well below normal',
    'Restore the water supply and check priming; fit dry-run protection'],
  ['P702', 'Overload', 'amber_warning', 'high',
    'Low voltage, an inter-turn short, or the pump working below its rated head (check P101, P202, P415)',
    'Check impeller choke and bearings; check the supply voltage'],
  ['P708', 'Locked rotor', 'red_stop', 'critical',
    'Jammed impeller, seized bearing, or a failed capacitor (the motor hums) (check P406, P302, P221)',
    'Switch off; check the capacitor, a jammed impeller and a seized bearing'],
];

export class MotorPCodes1765200000000 implements MigrationInterface {
  name = 'MotorPCodes1765200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP CONSTRAINT "ck_dtc_master_protocol"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD CONSTRAINT "ck_dtc_master_protocol" CHECK ("protocol" IN ('j1939', 'obd2', 'pcode'))`);
    await q.query(`ALTER TABLE "device_dtc_episode" DROP CONSTRAINT "ck_device_dtc_episode_protocol"`);
    await q.query(`ALTER TABLE "device_dtc_episode" ADD CONSTRAINT "ck_device_dtc_episode_protocol" CHECK ("protocol" IN ('j1939', 'obd2', 'pcode'))`);
    for (const [code, description, lamp, severity, causes, remedies] of CODES) {
      // 'pump-logger', not '1.0': 1.0 never held these, and its daily mirror must not be
      // read as their source.
      await q.query(
        `INSERT INTO "dtc_master_catalog" ("protocol", "code", "description", "lamp", "severity", "causes", "remedies", "source_system")
         VALUES ('pcode', $1, $2, $3, $4, $5, $6, 'pump-logger')
         ON CONFLICT ("protocol", "code") DO NOTHING`,
        [code, description, lamp, severity, causes, remedies]);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    // The narrower constraint cannot be restored over rows it forbids, so they go first.
    await q.query(`DELETE FROM "device_dtc_episode" WHERE "protocol" = 'pcode'`);
    await q.query(`DELETE FROM "dtc_master_catalog" WHERE "protocol" = 'pcode'`);
    await q.query(`ALTER TABLE "device_dtc_episode" DROP CONSTRAINT "ck_device_dtc_episode_protocol"`);
    await q.query(`ALTER TABLE "device_dtc_episode" ADD CONSTRAINT "ck_device_dtc_episode_protocol" CHECK ("protocol" IN ('j1939', 'obd2'))`);
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP CONSTRAINT "ck_dtc_master_protocol"`);
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD CONSTRAINT "ck_dtc_master_protocol" CHECK ("protocol" IN ('j1939', 'obd2'))`);
  }
}
