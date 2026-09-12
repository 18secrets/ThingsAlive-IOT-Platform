import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';

/**
 * A real Postgres for the database tests.
 *
 * pg-mem and sqlite would run faster and prove less: the things worth testing here
 * are a unique index deciding a conflict and a migration's down path, and both are
 * Postgres behaviour. Set DB_* in the environment to point at a throwaway database.
 */
export const TEST_DB = {
  DB_HOST: process.env.DB_HOST ?? 'localhost',
  DB_PORT: process.env.DB_PORT ?? '5432',
  DB_USERNAME: process.env.DB_USERNAME ?? 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_DATABASE: process.env.DB_DATABASE ?? 'ta2_test',
};

/**
 * Database tests need a real Postgres and are skipped without one, loudly enough
 * that a green run cannot be mistaken for a complete one. CI always sets DB_HOST.
 */
export const describeDb: jest.Describe = process.env.DB_HOST
  ? describe
  : ((name: string, fn: any) => {
      // eslint-disable-next-line no-console
      console.warn(`SKIPPED "${name}" — no DB_HOST. Run \`npm run test:db\` with Postgres.`);
      return describe.skip(name, fn);
    }) as any;

export async function createTestDataSource(): Promise<DataSource> {
  const ds = new DataSource(dataSourceOptions(TEST_DB as any));
  await ds.initialize();
  return ds;
}
