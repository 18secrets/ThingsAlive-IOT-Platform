import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two more of 1.0's columns kept on a vehicle code (fault code library, 17 Nov 2026):
 * which unit raised it, and the maker's own name for it.
 *
 * 1.0's `dtc_master` carries `source_type` (the controller that raises the code: engine,
 * transmission, after-treatment …) and `dtc_code` (the maker's code, as the machine's
 * manual and service tool call it). The daily copy dropped both. The same SPN can mean
 * different things on different units, and the technician looks the fault up in the
 * maker's manual, so both belong beside the code. Copied as 1.0 sends them; nothing in
 * 2.0 decides them.
 */
export class VehicleCodeSource1765500000000 implements MigrationInterface {
  name = 'VehicleCodeSource1765500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "dtc_master_catalog" ADD COLUMN "source_unit" text, ADD COLUMN "oem_code" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "dtc_master_catalog" DROP COLUMN "oem_code", DROP COLUMN "source_unit"`);
  }
}
