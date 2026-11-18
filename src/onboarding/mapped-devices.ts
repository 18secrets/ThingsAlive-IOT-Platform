import { EntityManager } from 'typeorm';

/**
 * Which devices are mapped to which machine: the one answer every reader of connection
 * status or telemetry asks before it shows either (17 Nov 2026).
 *
 * The rule is the onboarding order: a device is created, a machine is created, and the
 * device is mapped to the machine. Until the third step neither has a status or data to
 * show — an unmapped logger reporting is not a machine online, and a machine with no
 * logger is not offline, it is not onboarded. Showing either as Online/Offline is what
 * G04 forbids: missing data looking like a state.
 *
 * Mapped means either side said so:
 *  - 2.0's register: a device in this account claimed onto the machine;
 *  - 2.0's signal bindings: an active binding naming the device on the machine. The
 *    binding is the device authority (device-authority.spec), so a device bound to a
 *    machine's signals is mapped to it whether or not the claim was ever made;
 *  - 1.0's fitment, mirrored live: a device mapped in 1.0 is mapped, and the fleet sync
 *    carries it into the register after each pass. It counts here too, so the gap
 *    between a 1.0 change and the next pass does not show a machine as not onboarded.
 * Where they disagree — 2.0 has the device on another machine — 2.0 wins: that is a
 * mapping somebody made in 2.0 after 1.0's, and the sync reports it as a conflict
 * rather than moving it back.
 *
 * Bindings are judged at `at`, not the clock: a page asked as of a past moment shows
 * the devices mapped then, as its own readings are. With `ever`, a binding that has
 * ended still counts: a machine whose logger moved on was onboarded, and its history is
 * its own (device-authority.spec, a device moved between machines). Live status asks
 * "mapped now"; a page of history asks "ever mapped by then".
 *
 * SQL rather than TypeORM so the readers that already build one query (the link-health
 * fleet, the live view) can use it as a CTE and stay one round trip.
 */
export function mappedDevicesSql(tenantParam: string, atParam: string, ever = false): string {
  const ended = ever ? '' : ` AND (b."valid_to" IS NULL OR b."valid_to" > ${atParam})`;
  return `
    SELECT i."imei", i."equipment_external_id"
      FROM "device_inventory" i
     WHERE i."tenant_id" = ${tenantParam} AND i."state" = 'assigned' AND i."equipment_external_id" IS NOT NULL
    UNION
    SELECT b."imei", b."external_id"
      FROM "signal_binding_version" b
     WHERE b."tenant_id" = ${tenantParam} AND b."status" = 'active' AND b."imei" IS NOT NULL
       AND b."valid_from" <= ${atParam}${ended}
    UNION
    SELECT p."imei", p."equipment_external_id"
      FROM "device_projection" p
     WHERE p."tenant_id" = ${tenantParam} AND p."status" = 'live' AND p."equipment_external_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "device_inventory" o
          WHERE o."imei" = p."imei" AND o."equipment_external_id" IS NOT NULL
            AND (o."equipment_external_id" <> p."equipment_external_id" OR o."tenant_id" IS DISTINCT FROM p."tenant_id"))
       AND NOT EXISTS (
         SELECT 1 FROM "signal_binding_version" ob
          WHERE ob."imei" = p."imei" AND ob."status" = 'active' AND ob."valid_from" <= ${atParam} AND (ob."valid_to" IS NULL OR ob."valid_to" > ${atParam})
            AND ob."external_id" <> p."equipment_external_id")`;
}

/** The devices mapped to one machine. */
export async function mappedImeisFor(m: EntityManager, tenantId: string, externalId: string, at: Date = new Date()): Promise<string[]> {
  const rows: { imei: string }[] = await m.query(
    `SELECT DISTINCT "imei" FROM (${mappedDevicesSql('$1', '$3')}) d WHERE d."equipment_external_id" = $2 ORDER BY "imei"`,
    [tenantId, externalId, at],
  );
  return rows.map((r) => r.imei);
}

/** Of these machines, the ones with at least one device mapped. */
export async function onboardedMachines(
  m: EntityManager, tenantId: string, externalIds: string[], at: Date = new Date(), ever = false,
): Promise<Set<string>> {
  if (!externalIds.length) return new Set();
  const rows: { equipment_external_id: string }[] = await m.query(
    `SELECT DISTINCT "equipment_external_id" FROM (${mappedDevicesSql('$1', '$3', ever)}) d
      WHERE d."equipment_external_id" = ANY($2::text[])`,
    [tenantId, externalIds, at],
  );
  return new Set(rows.map((r) => r.equipment_external_id));
}
