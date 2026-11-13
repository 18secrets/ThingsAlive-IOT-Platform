import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The geofence map and each of Administration's tabs become pages a role is granted on
 * its own (13 Nov 2026).
 *
 * Until now the map opened for anyone holding "dashboard", and Sites, Devices, Equipment,
 * Models, Service roster and Fuel forecast all opened for anyone holding "admin". The
 * console now asks for the new grant itself, so a role that is not given it here loses a
 * page it had yesterday, with nobody having decided that. Each role keeps exactly what it
 * could open before; the account's owner takes away what they did not mean to give.
 *
 * Appended, never reordered, and only where missing, so a second run changes nothing.
 */
const ADMIN_TABS = [
  'admin-plant', 'admin-devices', 'admin-equipment', 'admin-model', 'admin-service-roster', 'admin-fuel-forecast-accuracy',
];

export class SeparateRolePages1765100000000 implements MigrationInterface {
  name = 'SeparateRolePages1765100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "tenant_role" SET "allowed_tabs" = "allowed_tabs" || ARRAY['geofence']::text[]
       WHERE 'dashboard' = ANY("allowed_tabs") AND NOT ('geofence' = ANY("allowed_tabs"))`);
    await q.query(`
      UPDATE "tenant_role" r
         SET "allowed_tabs" = r."allowed_tabs" || ARRAY(
               SELECT t FROM unnest($1::text[]) WITH ORDINALITY AS a(t, n)
                WHERE NOT (t = ANY(r."allowed_tabs")) ORDER BY n)
       WHERE 'admin' = ANY(r."allowed_tabs") AND NOT (r."allowed_tabs" @> $1::text[])`, [ADMIN_TABS]);
  }

  public async down(q: QueryRunner): Promise<void> {
    // The code before this does not know these pages and refuses any role naming one
    // (the alert-agent defect, StripRetiredRolePages), so they go. That code opened
    // these pages through "dashboard" and "admin" anyway.
    await q.query(`
      UPDATE "tenant_role"
         SET "allowed_tabs" = ARRAY(SELECT t FROM unnest("allowed_tabs") WITH ORDINALITY AS a(t, n)
                                     WHERE NOT (t = ANY($1::text[])) ORDER BY n)
       WHERE "allowed_tabs" && $1::text[]`, [['geofence', ...ADMIN_TABS]]);
  }
}
