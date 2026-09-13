import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * The read-only connection to the existing platform (task P1-110).
 *
 * Things Alive chose the database over the broker: 2.0 pulls the readings it needs for
 * a shift window rather than subscribing to every reading as it lands. That decision
 * makes this the only place 2.0 touches the existing platform, and the standing rule
 * for it has one direction — **read, never write**.
 *
 * The rule is not left to discipline. The session is opened with
 * `default_transaction_read_only=on`, so a write is refused by Postgres rather than by
 * a reviewer noticing: any INSERT, UPDATE, DELETE or DDL on this connection fails with
 * "cannot execute ... in a read-only transaction", including one issued by code that
 * has not been written yet. A read-only user on their side is still the right thing to
 * ask for; this is what makes the guarantee ours rather than theirs.
 *
 * Optional by design. Without the configuration there is no connection and nothing
 * pulls, which is the honest state of the system until a route and a grant exist.
 */
export interface LegacyDbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema?: string;
  ssl?: boolean;
}

export const LEGACY_DATA_SOURCE = Symbol('ta:legacy-data-source');

export function legacyConfigFrom(env: Record<string, string | undefined>): LegacyDbConfig | null {
  const host = env.LEGACY_DB_HOST?.trim();
  const database = env.LEGACY_DB_DATABASE?.trim();
  const username = env.LEGACY_DB_USERNAME?.trim();
  // A half-configured connection is worse than none: it fails at the first pull, in a
  // scheduled job nobody is watching, rather than at boot where somebody is.
  if (!host || !database || !username) return null;

  return {
    host,
    port: Number(env.LEGACY_DB_PORT ?? 5432),
    username,
    password: env.LEGACY_DB_PASSWORD ?? '',
    database,
    schema: env.LEGACY_DB_SCHEMA?.trim() || 'public',
    ssl: `${env.LEGACY_DB_SSL ?? ''}`.toLowerCase() === 'true',
  };
}

export function createLegacyDataSource(config: LegacyDbConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    schema: config.schema,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    // No entities and no migrations. This connection describes somebody else's schema,
    // which they are free to change; mapping it into TypeORM entities here would mean
    // 2.0 carrying a second copy of their model and breaking when they alter it.
    entities: [],
    migrations: [],
    synchronize: false,
    logging: false,
    extra: {
      // The guarantee. Every transaction on this connection is read-only at the
      // database, so "2.0 never writes to the existing platform" is enforced rather
      // than promised.
      options: '-c default_transaction_read_only=on',
      max: 4,
      // A pull that hangs must not hold the runner open indefinitely; the window is
      // still owed and the next pass will take it.
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    },
  });
}

export async function initLegacyDataSource(
  config: LegacyDbConfig | null, logger = new Logger('LegacyDataSource'),
): Promise<DataSource | null> {
  if (!config) {
    logger.warn(
      'No LEGACY_DB_* configuration. Telemetry will not be pulled from the existing '
      + 'platform, so nothing will be scored. This is expected until a route and a '
      + 'read-only user exist.',
    );
    return null;
  }
  const ds = createLegacyDataSource(config);
  await ds.initialize();
  logger.log(`Reading from ${config.host}/${config.database} as ${config.username} (read-only).`);
  return ds;
}
