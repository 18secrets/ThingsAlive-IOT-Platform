import { DataSource, DataSourceOptions } from 'typeorm';
import { EquipmentProjection } from '../projection/entities/equipment-projection.entity';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { TenantMap } from '../projection/entities/tenant-map.entity';
import { TelemetryReading } from '../telemetry/telemetry-reading.entity';
import { PlatformAccessLog } from '../audit/platform-access-log.entity';
import { EquipmentClassProfile } from '../catalog/entities/equipment-class-profile.entity';
import { EquipmentClassFormula } from '../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { SensorRoleCapability } from '../device-catalog/entities/sensor-role-capability.entity';
import { ScenarioDefinition } from '../catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../catalog/entities/signal-alias.entity';
import { AlertRuleTemplate } from '../catalog/entities/alert-rule-template.entity';
import { ClientCatalogEntitlement } from '../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { ClientScenario } from '../client-catalog/entities/client-scenario.entity';
import { EquipmentScenario } from '../activation/entities/equipment-scenario.entity';
import { ScenarioActivationEvent } from '../activation/entities/scenario-activation-event.entity';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentPlacementEvent } from '../equipment/entities/equipment-placement-event.entity';
import { WorkOrder, WorkOrderCounter } from '../work/entities/work-order.entity';
import { WorkOrderEvent } from '../work/entities/work-order-event.entity';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { AlertEvent } from '../alert/entities/alert-event.entity';
import { EquipmentShift } from '../shift/entities/equipment-shift.entity';
import { ShiftRun } from '../shift/entities/shift-run.entity';
import { UtilizationShift } from '../utilization/entities/utilization-shift.entity';
import { EquipmentServiceRecord } from '../service/entities/equipment-service-record.entity';
import { DeviceLinkHealth } from '../device-health/entities/device-link-health.entity';
import { CausalChainDefinition } from '../intelligence/entities/causal-chain.entity';
import { Tenant } from '../tenancy/entities/tenant.entity';
import { AppUser } from '../identity/entities/app-user.entity';
import { UserInvitation } from '../identity/entities/user-invitation.entity';
import { UserSecurityEvent } from '../identity/entities/user-security-event.entity';
import { UserSession } from '../identity/entities/user-session.entity';
import { TenantRole } from '../identity/entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from '../identity/entities/user-access.entity';
import { PlatformUser } from '../identity/entities/platform-user.entity';
import { PlatformSession } from '../identity/entities/platform-session.entity';
import { DeviceInventory } from '../inventory/entities/device-inventory.entity';
import { DeviceInventoryEvent } from '../inventory/entities/device-inventory-event.entity';
import { SensorCategory } from '../device-catalog/entities/sensor-category.entity';
import { Sensor } from '../device-catalog/entities/sensor.entity';
import { ToolMapping } from '../device-catalog/entities/tool-mapping.entity';
import { EquipmentTemplate } from '../equipment-template/entities/equipment-template.entity';
import { Prediction } from '../prediction/entities/prediction.entity';
import { PredictionBaseline } from '../prediction/entities/prediction-baseline.entity';
import { DomainEvent } from '../events/domain-event.entity';
import { CatalogImportBatch } from '../catalog-import/entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../catalog-import/entities/catalog-import-row.entity';

/**
 * 2.0 owns its own database. Nothing here joins to the existing platform's schema —
 * foreign data arrives as projections through a contract, never as a cross-database
 * query. See the projection module for why.
 */
export const ENTITIES = [
  TenantMap,
  EquipmentProjection,
  DeviceProjection,
  SensorMapProjection,
  ProjectionRejection,
  TelemetryReading,
  PlatformAccessLog,
  EquipmentClassProfile,
  ScenarioDefinition,
  SignalAlias,
  AlertRuleTemplate,
  ClientCatalogEntitlement,
  EquipmentProfile,
  ClientEquipmentClass,
  ClientScenario,
  EquipmentScenario,
  ScenarioActivationEvent,
  DomainEvent,
  Prediction,
  PredictionBaseline,
  DeviceInventory,
  DeviceInventoryEvent,
  TenantRole,
  AppUser,
  UserPlantAccess,
  UserEquipmentAccess,
  UserInvitation,
  UserSession,
  UserSecurityEvent,
  Tenant,
  Plant,
  EquipmentPlacementEvent,
  WorkOrder,
  WorkOrderCounter,
  WorkOrderEvent,
  EquipmentShift,
  ShiftRun,
  UtilizationShift,
  EquipmentServiceRecord,
  DeviceLinkHealth,
  CausalChainDefinition,
  AlertRule,
  AlertEvent,
  PlatformUser,
  PlatformSession,
  SensorCategory,
  Sensor,
  ToolMapping,
  EquipmentTemplate,
  CatalogImportBatch,
  CatalogImportRow,
  EquipmentClassFormula,
  EquipmentClassSensorRequirement,
  SensorRoleCapability,
];

export interface DataSourceChoices {
  /**
   * The role every connection in this pool runs as. Null keeps the login user, which
   * migrations need — they create tables, and `ta_app` cannot.
   *
   * Everything else uses the constrained role. It is set at connection start rather
   * than per query, so a query that skipped ScopedRepository is *also* subject to
   * row-level security. A pool that connects as the owner would leave the policy
   * protecting only the code that was already filtering correctly.
   */
  appRole?: string | null;
}

export function dataSourceOptions(
  env = process.env,
  choices: DataSourceChoices = {},
): DataSourceOptions {
  const appRole = choices.appRole === undefined ? (env.DB_APP_ROLE ?? 'ta_app') : choices.appRole;
  return {
    type: 'postgres',
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    username: env.DB_USERNAME ?? 'postgres',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_DATABASE ?? 'ta2',
    // Migrations only. The existing platform sets this too; the difference is that
    // here there is no history of it ever having been true.
    synchronize: false,
    logging: false,
    entities: ENTITIES,
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    // TLS is required anywhere the database is not on the same private network.
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    // A startup parameter, so it applies from the first statement on every pooled
    // connection. If the role does not exist the service refuses to connect, which is
    // the right failure: migrations create it, and a silent fall back to the login
    // user would look healthy while enforcing nothing.
    ...(appRole ? { extra: { options: `-c role=${appRole}` } } : {}),
  };
}

/**
 * The migration data source. Runs as the login user: `ta_app` is deliberately unable
 * to create or alter a table, so migrations cannot run under it.
 */
export default new DataSource(dataSourceOptions(process.env, { appRole: null }));
