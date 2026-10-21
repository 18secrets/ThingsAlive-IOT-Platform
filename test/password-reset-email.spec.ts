import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AuthController } from '../src/identity/auth.controller';
import { CredentialService } from '../src/identity/services/credential.service';
import { PasswordService } from '../src/identity/services/password.service';
import { PlatformCredentialService } from '../src/identity/services/platform-credential.service';
import { MailService } from '../src/mail/mail.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Forgot password actually sends an email (dashboard testing, issue 10).
 *
 * Before this the reset token was minted and dropped, and staff had no reset at all.
 * The provider's HTTP API is stubbed: what is tested is that the right request leaves,
 * that the link in it really resets the password, and that nothing about the response
 * changes with whether the address exists or the send worked.
 */
describeDb('password reset email', () => {
  let ds: DataSource;
  let owner: DataSource;
  let credentials: CredentialService;
  let platformCredentials: PlatformCredentialService;
  let fetchSpy: jest.SpyInstance;
  const passwords = new PasswordService();
  const NEW_PASSWORD = 'Brand-New-Horse-7';
  let settings: Record<string, string>;

  const controller = () => {
    const mail = new MailService({ get: (key: string) => settings[key] } as unknown as ConfigService);
    return new AuthController(credentials, platformCredentials, passwords, mail);
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    const config = {
      get: (key: string) => ({ AUTH_JWT_SECRET: 'test-secret-for-signing', AUTH_TENANT_CLAIM: 'client_id' } as Record<string, string>)[key],
    } as unknown as ConfigService;
    credentials = new CredentialService(ds, passwords, new JwtService({}), config);
    platformCredentials = new PlatformCredentialService(ds, passwords, new JwtService({}), config);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['user_security_event', 'user_session', 'user_invitation', 'platform_session',
      'platform_invitation', 'app_user', 'tenant_role', 'platform_user']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    await owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape)
        VALUES ('acme', 'operator', 'Operator', '{}', 'tenant')`,
    );
    await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, password_hash)
        VALUES ('acme', 'op@acme.test', 'Op', 'operator', 'active', $1)`, [passwords.hash('Old-Client-Horse-7')],
    );
    await owner.query(
      `INSERT INTO platform_user (email, full_name, role, status, password_hash)
        VALUES ('ops@things-alive.io', 'Ops', 'platform-support', 'active', $1)`, [passwords.hash('Old-Staff-Horse-7')],
    );
    settings = {
      MAIL_PROVIDER: 'resend', MAIL_API_KEY: 're_test_key', MAIL_FROM: 'no-reply@things-alive.io',
      CORS_ORIGINS: 'https://console.example.test/,http://localhost:3000',
    };
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
  });

  afterEach(() => fetchSpy.mockRestore());

  /** The send is fire-and-forget on purpose; wait for it to leave, or for it not to. */
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10)); };
  const sentLink = (): string => {
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    return /https?:\/\/\S+/.exec(body.text)![0];
  };
  const tokenFrom = (link: string) => new URL(link).searchParams.get('invite')!;

  it('emails a client user a link that resets their password', async () => {
    await expect(controller().forgotPassword({ email: 'OP@acme.test' }, '127.0.0.1')).resolves.toEqual({ sent: true });
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_test_key' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: 'no-reply@things-alive.io', to: ['op@acme.test'] });
    expect(sentLink()).toMatch(/^https:\/\/console\.example\.test\/accept-invitation\?invite=.+&reset=1$/);

    await credentials.acceptInvitation(tokenFrom(sentLink()), NEW_PASSWORD, {});
    await expect(credentials.signIn('op@acme.test', NEW_PASSWORD, {})).resolves.toBeTruthy();
  });

  it('emails a staff member a link that resets theirs', async () => {
    await controller().forgotPassword({ email: 'ops@things-alive.io' }, '127.0.0.1');
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await platformCredentials.acceptInvitation(tokenFrom(sentLink()), NEW_PASSWORD, {});
    await expect(platformCredentials.signIn('ops@things-alive.io', NEW_PASSWORD, {})).resolves.toBeTruthy();
  });

  it('sends nothing for an unknown address or a suspended person, and answers the same', async () => {
    await owner.query(`UPDATE platform_user SET status = 'suspended'`);
    await expect(controller().forgotPassword({ email: 'nobody@acme.test' }, '127.0.0.1')).resolves.toEqual({ sent: true });
    await expect(controller().forgotPassword({ email: 'ops@things-alive.io' }, '127.0.0.1')).resolves.toEqual({ sent: true });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers the same when the provider refuses, or when no provider is set', async () => {
    fetchSpy.mockResolvedValue(new Response('{"message":"invalid key"}', { status: 401 }));
    await expect(controller().forgotPassword({ email: 'op@acme.test' }, '127.0.0.1')).resolves.toEqual({ sent: true });
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    delete settings.MAIL_PROVIDER;
    await expect(controller().forgotPassword({ email: 'op@acme.test' }, '127.0.0.1')).resolves.toEqual({ sent: true });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('speaks SendGrid when asked to', async () => {
    settings.MAIL_PROVIDER = 'sendgrid';
    settings.APP_PUBLIC_URL = 'https://app.example.test';
    await controller().forgotPassword({ email: 'op@acme.test' }, '127.0.0.1');
    await settle();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    const body = JSON.parse(init.body as string);
    expect(body.personalizations).toEqual([{ to: [{ email: 'op@acme.test' }] }]);
    expect(body.content[0].value).toContain('https://app.example.test/accept-invitation?invite=');
  });

  it('retires an earlier reset link when a new one is asked for', async () => {
    await controller().forgotPassword({ email: 'ops@things-alive.io' }, '127.0.0.1');
    await settle();
    const first = tokenFrom(sentLink());
    fetchSpy.mockClear();
    await controller().forgotPassword({ email: 'ops@things-alive.io' }, '127.0.0.1');
    await settle();

    await expect(platformCredentials.acceptInvitation(first, NEW_PASSWORD, {})).rejects.toThrow();
    await expect(platformCredentials.acceptInvitation(tokenFrom(sentLink()), NEW_PASSWORD, {})).resolves.toBeTruthy();
  });
});
