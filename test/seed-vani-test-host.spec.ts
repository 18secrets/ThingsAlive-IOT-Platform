import { requireLocal } from '../src/database/seeds/seed-vani-test';

/**
 * Where `seed:vani-test` may write. Local databases always; a shared one only when the
 * run names that exact host. Each case attempts the run and expects the refusal — the
 * exception is narrow on purpose, so the near misses are the cases that matter.
 */
describe('seed:vani-test: which databases it will write to', () => {
  const DEV = 'shared-db.example.test';
  const devUrl = `postgres://u:p@${DEV}:5432/railway`; // scan-allow

  it('writes to a shared host the run names exactly', () => {
    expect(() => requireLocal({ DATABASE_URL: devUrl, SEED_VANI_TEST_ALLOW_HOST: DEV })).not.toThrow();
    expect(() => requireLocal({ DB_HOST: DEV, SEED_VANI_TEST_ALLOW_HOST: DEV })).not.toThrow();
  });

  it('refuses a shared host that is not named, or named as a switch rather than a host', () => {
    expect(() => requireLocal({ DATABASE_URL: devUrl })).toThrow(/SEED_VANI_TEST_ALLOW_HOST=shared-db\.example\.test/);
    expect(() => requireLocal({ DATABASE_URL: devUrl, SEED_VANI_TEST_ALLOW_HOST: 'true' })).toThrow(/local database only/);
    expect(() => requireLocal({ DATABASE_URL: devUrl, SEED_VANI_TEST_ALLOW_HOST: '' })).toThrow(/local database only/);
  });

  it('refuses a different shared host from the one named', () => {
    expect(() => requireLocal({ DB_HOST: 'postgres.railway.internal', SEED_VANI_TEST_ALLOW_HOST: DEV })).toThrow(/local database only/);
  });
});
