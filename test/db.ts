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

/**
 * Two connections, because they prove different things.
 *
 * The owner runs migrations and sets up fixtures. The application connection runs as
 * `ta_app`, exactly as the service does, and is the only one that can demonstrate
 * anything about row-level security: a superuser bypasses every policy, so a test
 * run as one is a test of nothing.
 */
export async function createTestDataSource(
  choices: { appRole?: string | null } = { appRole: null },
): Promise<DataSource> {
  const ds = new DataSource(dataSourceOptions(TEST_DB as any, choices));
  await ds.initialize();
  return ds;
}

/** The constrained connection. Mirrors how the running service connects. */
export const createAppDataSource = (): Promise<DataSource> => createTestDataSource({});

/**
 * Undoes migrations one at a time until the named one has been reverted, then stops.
 *
 * `undoLastMigration()` alone reverts whichever migration happens to be newest — a
 * moving target that stops meaning "this migration" the moment somebody adds a later
 * one. A down-path test has to name its own migration, not "the last one" (task
 * QIMP1 follow-up: this is what broke `library-structure.spec.ts` and
 * `signal-binding.spec.ts` the moment `CatalogImport1757980000000` landed after both).
 */
export async function undoMigrationNamed(ds: DataSource, migrationName: string): Promise<void> {
  for (;;) {
    const [row] = await ds.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
    const current: string | undefined = row?.name;
    if (!current) {
      throw new Error(`Migration "${migrationName}" was never applied — nothing left to undo.`);
    }
    await ds.undoLastMigration({ transaction: 'all' });
    if (current === migrationName) return;
  }
}
