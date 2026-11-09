import { EntityManager } from 'typeorm';

export interface RoutedEngineer {
  userId: string;
  regionCode: string;
  rank: number;
}

/**
 * The engineer a job on this machine goes to: the machine's site, the site's region,
 * the region's highest-ranked engineer who can still sign in (U5).
 *
 * Suspended engineers are passed over rather than routed to, so a roster nobody has
 * tidied after somebody left still reaches the next person instead of a dead account.
 * Invited ones are not: they have a login waiting, and the job is there when they use it.
 *
 * Null when the machine has no site, the site no region, or the region nobody who can
 * take it. The caller then leaves the job unassigned, which is what it did before a
 * roster existed, so an account without one sees no change at all.
 *
 * Runs inside the caller's tenant session, so RLS narrows every table read here.
 */
export async function routeToEngineer(
  m: EntityManager, tenantId: string, sourceSystem: string, externalId: string,
): Promise<RoutedEngineer | null> {
  const [row] = await m.query(
    `SELECT e."user_id" AS "userId", e."region_code" AS "regionCode", e."rank"
       FROM "equipment_profile" p
       JOIN "service_region_plant" rp ON rp."tenant_id" = p."tenant_id" AND rp."plant_id" = p."plant_id"
       JOIN "service_region_engineer" e ON e."tenant_id" = rp."tenant_id" AND e."region_code" = rp."region_code"
       JOIN "app_user" u ON u."tenant_id" = e."tenant_id" AND u."id" = e."user_id"
      WHERE p."tenant_id" = $1 AND p."source_system" = $2 AND p."external_id" = $3
        AND u."status" <> 'suspended'
      ORDER BY e."rank"
      LIMIT 1`,
    [tenantId, sourceSystem, externalId],
  );
  return row ? { userId: row.userId, regionCode: row.regionCode, rank: Number(row.rank) } : null;
}
