import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main';
import { PLATFORM_ROLES } from '../src/auth/platform-roles';
import {
  DEFAULT_PLATFORM_TENANT, MAX_EXPIRY_MINUTES, MintRefusal, mintPlatformToken,
} from '../src/platform/platform-token';

/**
 * Task D-11 — the first credential.
 *
 * This closes a gap that only appears on a deployment nobody has used yet: creating
 * an account needs `tenant.provision`, which needs `master-admin`, which is a role the
 * guard reads from a token — and no user row anywhere can produce one. A freshly
 * deployed platform was therefore complete, correct, serving, and impossible to sign
 * into. Every test suite hid it by constructing scopes directly.
 *
 * What is asserted here is mostly refusals, because a bad platform token does not fail
 * loudly. It verifies, it carries a role, it resolves no capabilities, and every route
 * answers 403 — which reads like a permissions bug and is in fact a typo.
 */
const SECRET = 'a-real-secret-nobody-has-published-anywhere';
const verify = (token: string, issuer?: string) =>
  new JwtService({}).verify(token, { secret: SECRET, issuer }) as Record<string, any>;

describe('minting a platform token (D-11)', () => {
  describe('what it produces', () => {
    it('carries exactly the three claims the auth guard reads', () => {
      const minted = mintPlatformToken(
        { role: 'master-admin', subject: 'deepak@things-alive.io' },
        { secret: SECRET },
      );
      const payload = verify(minted.token);

      // The guard reads sub, the tenant claim, and roles. Anything else is decoration;
      // anything missing is a 401 with a message about the wrong thing.
      expect(payload.sub).toBe('deepak@things-alive.io');
      expect(payload.client_id).toBe(DEFAULT_PLATFORM_TENANT);
      expect(payload.roles).toEqual(['master-admin']);
    });

    it('honours a renamed tenant claim, because the guard reads it from config', () => {
      const minted = mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io', tenantId: 'platform' },
        { secret: SECRET, tenantClaim: 'org_id' },
      );
      const payload = verify(minted.token);
      expect(payload.org_id).toBe('platform');
      expect(payload.client_id).toBeUndefined();
    });

    it('signs with the issuer the guard will check', () => {
      const minted = mintPlatformToken(
        { role: 'catalog-author', subject: 'author@things-alive.io' },
        { secret: SECRET, issuer: 'things-alive-platform' },
      );
      expect(verify(minted.token, 'things-alive-platform').iss).toBe('things-alive-platform');
      // And a token minted for one issuer is not accepted for another.
      expect(() => verify(minted.token, 'somebody-else')).toThrow();
    });

    it('expires, and says when', () => {
      const now = new Date('2026-09-15T00:00:00Z');
      const minted = mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io', expiresInMinutes: 60 },
        { secret: SECRET },
        now,
      );
      expect(minted.expiresAt.toISOString()).toBe('2026-09-15T01:00:00.000Z');
      expect(verify(minted.token).exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('mints every role the guard treats as a platform role, and only those', () => {
      // The two lists are the same list. If they ever stop being, a token that
      // verifies would resolve no capabilities and nothing would say why.
      for (const role of PLATFORM_ROLES) {
        expect(() =>
          mintPlatformToken({ role, subject: 'ops@things-alive.io' }, { secret: SECRET }),
        ).not.toThrow();
      }
    });
  });

  describe('what it refuses', () => {
    it('refuses a role the guard would not recognise', () => {
      // 'admin' is a real role — inside a tenant. As a platform token it produces a
      // caller with authority over nothing and no error to explain it.
      expect(() => mintPlatformToken(
        { role: 'admin', subject: 'ops@things-alive.io' }, { secret: SECRET },
      )).toThrow(MintRefusal);
      expect(() => mintPlatformToken(
        { role: 'super admin', subject: 'ops@things-alive.io' }, { secret: SECRET },
      )).toThrow(/not a platform role/);
    });

    it('refuses without a subject, because provisioning records who did it', () => {
      expect(() => mintPlatformToken(
        { role: 'master-admin', subject: '  ' }, { secret: SECRET },
      )).toThrow(/subject is required/);
    });

    it('refuses without a secret', () => {
      expect(() => mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io' }, { secret: '' },
      )).toThrow(/AUTH_JWT_SECRET is not set/);
    });

    it('refuses a placeholder secret', () => {
      // The one that matters: ci-test-secret is in .gitlab-ci.yml and in the GitHub
      // workflow. A token minted against it is forgeable by anyone who can read the
      // repository, and it would work perfectly, which is the problem.
      for (const weak of ['ci-test-secret', 'CHANGEME', 'secret']) {
        expect(() => mintPlatformToken(
          { role: 'master-admin', subject: 'ops@things-alive.io' }, { secret: weak },
        )).toThrow(/placeholder/);
      }
    });

    it('caps the lifetime, because a platform token cannot be revoked', () => {
      // There is no row to suspend and no session to end — expiry is the only thing
      // that ever takes it away, so "expires in a year" is a permanent key.
      expect(() => mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io', expiresInMinutes: MAX_EXPIRY_MINUTES + 1 },
        { secret: SECRET },
      )).toThrow(/cannot be revoked/);

      expect(() => mintPlatformToken(
        { role: 'master-admin', subject: 'ops@things-alive.io', expiresInMinutes: 0 },
        { secret: SECRET },
      )).toThrow(/positive number/);
    });
  });

  /**
   * The assertion that actually matters: a token this mints is a token the running
   * application accepts. Everything above checks claims in isolation, and claims in
   * isolation are exactly what was already right — the gap was that nothing ever put
   * one through the guard.
   */
  describe('against the running application', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = SECRET;
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      delete process.env.AUTH_JWT_ISSUER;
      app = await createApp({ database: false });
      await app.init();
    });

    afterAll(async () => { await app?.close(); });

    it('is accepted, and arrives as a platform scope', async () => {
      const { token } = mintPlatformToken(
        { role: 'master-admin', subject: 'deepak@things-alive.io' },
        { secret: SECRET },
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(['master-admin']);
      // The flag that tells the guard not to look for a row that does not exist.
      expect(res.body.isPlatformRole).toBe(true);
      expect(res.body.tenantId).toBe(DEFAULT_PLATFORM_TENANT);
    });

    it('a token signed with a different secret is refused', async () => {
      const { token } = mintPlatformToken(
        { role: 'master-admin', subject: 'attacker@example.com' },
        { secret: 'a-different-secret-entirely-not-the-real-one' },
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
    });
  });
});
