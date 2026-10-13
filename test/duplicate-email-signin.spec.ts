import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AuthController } from '../src/identity/auth.controller';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Signing in on an address that is both a staff and a client login (dashboard
 * testing, issue 2, the pairs created before the email rule existed).
 *
 * Sign-in used to take the staff account whenever one existed, so the client user on
 * the same address was told their password was wrong forever. Now the password picks
 * the account. The fixture plants the pair with the uniqueness trigger switched off,
 * which is how the old pairs came to be.
 */
describeDb('signing in on an address that is both staff and client', () => {
  let ds: DataSource;
  let owner: DataSource;
  let auth: AuthController;
  const passwords = new PasswordService();
  const STAFF_PASSWORD = 'Staff-Horse-12';
  const CLIENT_PASSWORD = 'Client-Horse-12';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: 'test-secret-for-signing', AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    auth = new AuthController(
      new CredentialService(ds, passwords, new JwtService({}), config),
      new PlatformCredentialService(ds, passwords, new JwtService({}), config),
      passwords,
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_security_event', 'user_session', 'platform_session', 'app_user', 'tenant_role', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape)
        VALUES ('acme', 'ceo-manager', 'CEO', '{user.manage,role.manage}', 'tenant')`,
    );
    await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, password_hash)
        VALUES ('acme', 'unity@gmail.com', 'Unity Client', 'ceo-manager', 'active', $1)`,
      [passwords.hash(CLIENT_PASSWORD)],
    );
    await owner.query(`ALTER TABLE platform_user DISABLE TRIGGER trg_login_email_unclaimed`);
    try {
      await owner.query(
        `INSERT INTO platform_user (email, full_name, role, status, password_hash)
          VALUES ('unity@gmail.com', 'Unity Staff', 'master-admin', 'active', $1)`,
        [passwords.hash(STAFF_PASSWORD)],
      );
    } finally {
      await owner.query(`ALTER TABLE platform_user ENABLE TRIGGER trg_login_email_unclaimed`);
    }
  });

  const failures = async () => (await owner.query(
    `SELECT (SELECT failed_attempts FROM app_user WHERE email = 'unity@gmail.com') AS client,
            (SELECT failed_attempts FROM platform_user WHERE email = 'unity@gmail.com') AS staff`,
  ))[0];
  const sessions = async () => (await owner.query(
    `SELECT (SELECT count(*) FROM user_session)::int AS client, (SELECT count(*) FROM platform_session)::int AS staff`,
  ))[0];

  it("signs the client user in with the client's password", async () => {
    await expect(auth.signIn({ email: 'unity@gmail.com', password: CLIENT_PASSWORD }, '127.0.0.1')).resolves.toBeTruthy();
    expect(await sessions()).toEqual({ client: 1, staff: 0 });
  });

  it("signs the staff member in with the staff password", async () => {
    await expect(auth.signIn({ email: 'unity@gmail.com', password: STAFF_PASSWORD }, '127.0.0.1')).resolves.toBeTruthy();
    expect(await sessions()).toEqual({ client: 0, staff: 1 });
  });

  it('counts a wrong password against the client account, never the staff one', async () => {
    await expect(auth.signIn({ email: 'unity@gmail.com', password: 'Wrong-Horse-12' }, '127.0.0.1')).rejects.toThrow();
    expect(await failures()).toEqual({ client: 1, staff: 0 });
  });

  it('leaves an ordinary staff sign-in as it was', async () => {
    await owner.query(`DELETE FROM app_user`);
    await expect(auth.signIn({ email: 'unity@gmail.com', password: 'Wrong-Horse-12' }, '127.0.0.1')).rejects.toThrow();
    expect((await failures()).staff).toBe(1);
    await expect(auth.signIn({ email: 'unity@gmail.com', password: STAFF_PASSWORD }, '127.0.0.1')).resolves.toBeTruthy();
  });
});
