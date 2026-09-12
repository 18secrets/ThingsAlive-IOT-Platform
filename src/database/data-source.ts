import { DataSource, DataSourceOptions } from 'typeorm';
import { EquipmentProjection } from '../projection/entities/equipment-projection.entity';
import { DeviceProjection } from '../projection/entities/device-projection.entity';
import { SensorMapProjection } from '../projection/entities/sensor-map-projection.entity';
import { ProjectionRejection } from '../projection/entities/projection-rejection.entity';
import { TenantMap } from '../projection/entities/tenant-map.entity';
import { TelemetryReading } from '../telemetry/telemetry-reading.entity';

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
];

export function dataSourceOptions(env = process.env): DataSourceOptions {
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
  };
}

export default new DataSource(dataSourceOptions());
