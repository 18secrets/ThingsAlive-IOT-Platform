/**
 * What makes a table subject to tenant isolation (task P1-52).
 *
 * An entity is scopable only if it carries `tenantId`. That is a type-level
 * requirement, not a convention: `ScopedRepository<T>` will not accept an entity
 * without it, so a new tenant-owned table cannot quietly skip the tenant column and
 * still be queried through the safe path.
 */
export interface TenantOwnedEntity {
  tenantId: string;
}

/**
 * Which columns a scope can narrow, beyond the tenant.
 *
 * The tenant is mandatory and universal. Plant, equipment and device restrictions
 * apply only where the table has something to match them against — a reading is
 * narrowed by IMEI, a piece of equipment by its own identifier. A table that omits
 * these is still tenant-isolated; it is simply not narrowed further.
 */
export interface ScopedEntityMeta<T> {
  /** Property holding the equipment identifier, matched against scope.equipmentIds. */
  readonly equipmentColumn?: keyof T & string;
  /** Property holding the device identifier, matched against scope.deviceIds. */
  readonly deviceColumn?: keyof T & string;
  /** Property holding the plant identifier, matched against scope.plantIds. */
  readonly plantColumn?: keyof T & string;
}
