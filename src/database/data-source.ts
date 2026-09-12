import { DataSource, DataSourceOptions } from 'typeorm';
import { EquipmentProjection } from '../projection/entities/equipment-projection.entity';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { TenantMap } from '../projection/entities/tenant-map.entity';
import { TelemetryReading } from '../telemetry/telemetry-reading.entity';
import { PlatformAccessLog } from '../audit/platform-access-log.entity';
import { EquipmentClassProfile } from '../catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../catalog/entities/signal-alias.entity';
import { ClientCatalogEntitlement } from '../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { ClientScenario } from '../client-catalog/entities/client-scenario.entity';
import { EquipmentScenario } from '../activation/entities/equipment-scenario.entity';
import { ScenarioActivationEvent } from '../activation/entities/scenario-activation-event.entity';
import { Prediction } from '../prediction/entities/prediction.entity';
import { PredictionBaseline } from '../prediction/entities/prediction-baseline.entity';
import { DomainEvent } from '../events/domain-event.entity';

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
  ClientCatalogEntitlement,
  EquipmentProfile,
  ClientEquipmentClass,
  ClientScenario,
  EquipmentScenario,
  ScenarioActivationEvent,
  DomainEvent,
  Prediction,
  PredictionBaseline,
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
