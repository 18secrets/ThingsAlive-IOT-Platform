import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { runTenantSpanning } from '../../scope/tenant-session';
import { PLATFORM_ROLES, PlatformRole } from '../../auth/platform-roles';
import { PlatformUser } from '../entities/platform-user.entity';
import { PlatformSession } from '../entities/platform-session.entity';
import { UserSecurityEvent, SecurityEventType } from '../entities/user-security-event.entity';
import { PasswordService } from './password.service';
import { ACCESS_TOKEN_SECONDS, RequestContext, SignInResult } from './credential.service';

type Refusal = { kind: 'refused'; message: string };
type Allowed<T> = { kind: 'allowed'; value: T };
type Outcome<T> = Allowed<T> | Refusal;
const refuse = (message: string): Refusal => ({ kind: 'refused', message });
const allow = <T>(value: T): Allowed<T> => ({ kind: 'allowed', value });

const REFRESH_TOKEN_DAYS = 30;
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Sign-in for Things Alive staff — PlatformUser's counterpart to CredentialService.
 *
 * The token this issues is deliberately shaped exactly like the one `mint-token.ts`
 * produces: a `roles` claim naming one of PLATFORM_ROLES and the tenant claim set to
 * a fixed sentinel. AuthGuard decides `isPlatformRole` purely from that `roles`
 * claim (auth.guard.ts) and, for a platform role, never resolves scope from the
 * database — so an access token from here is indistinguishable to the rest of the
 * app from one minted by the CLI script, and needs no guard change to work.
 *
 * What it adds over the CLI script is what a login is supposed to be: a password
 * instead of shell access to the running service, and a refresh token that can be
 * revoked by deleting the session row. What it does not add is per-request
 * revocation of an already-issued *access* token — that still lives out its hour
 * (ACCESS_TOKEN_SECONDS) regardless, same as the CLI-minted token always did, and
 * same as the guard's documented decision not to look platform tokens up at all.
 */
@Injectable()
export class PlatformCredentialService {
  private readonly logger = new Logger(PlatformCredentialService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async findByEmail(email: string): Promise<PlatformUser | null> {
    return this.ds.getRepository(PlatformUser).findOne({ where: { email: email.trim().toLowerCase() } });
  }

  /** Routes a refresh/sign-out call: does this opaque token belong to a platform session at all? */
  async hasSession(refreshToken: string): Promise<boolean> {
    const hash = this.passwords.fingerprint(refreshToken);
    return (await this.ds.getRepository(PlatformSession).count({ where: { tokenHash: hash } })) > 0;
  }

  async signIn(email: string, password: string, ctx: RequestContext = {}, now = new Date()): Promise<SignInResult> {
    const normalised = email.trim().toLowerCase();

    // Neither platform_user nor platform_session carries RLS — but user_security_event
    // does (see the Credentials migration), and this method writes to it with no
    // tenant in scope, the same reason CredentialService.signIn spans tenants too.
    const outcome = await runTenantSpanning(this.ds, 'platform sign-in', async (m) => {
      const repo = m.getRepository(PlatformUser);
      const user = await repo.findOne({ where: { email: normalised } });

      if (!user) {
        await this.record(m, 'login.failed', { emailAttempted: normalised, ctx, detail: 'no such address' });
        return refuse('Email or password is incorrect.');
      }

      if (user.lockedUntil && user.lockedUntil > now) {
        const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
        await this.record(m, 'login.failed', { userId: user.id, ctx, detail: 'locked' });
        return refuse(`Too many failed attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
      }

      if (!this.passwords.verify(password, user.passwordHash)) {
        user.failedAttempts = (user.failedAttempts ?? 0) + 1;
        if (user.failedAttempts >= MAX_FAILURES) {
          user.lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000);
          user.failedAttempts = 0;
          await repo.save(user);
          await this.record(m, 'login.locked', { userId: user.id, ctx });
        } else {
          await repo.save(user);
          await this.record(m, 'login.failed', { userId: user.id, ctx, detail: 'wrong password' });
        }
        return refuse('Email or password is incorrect.');
      }

      if (user.status === 'suspended') {
        await this.record(m, 'login.failed', { userId: user.id, ctx, detail: 'suspended' });
        return refuse('This account has been suspended.');
      }

      user.failedAttempts = 0;
      user.lockedUntil = null;
      await repo.save(user);
      await this.record(m, 'login.succeeded', { userId: user.id, ctx });

      return allow(await this.startSession(m, user, ctx, now));
    });

    if (outcome.kind === 'refused') throw new UnauthorizedException(outcome.message);
    return outcome.value;
  }

  async refresh(refreshToken: string, ctx: RequestContext = {}, now = new Date()): Promise<SignInResult> {
    const hash = this.passwords.fingerprint(refreshToken);

    const outcome = await runTenantSpanning(this.ds, 'platform session refresh', async (m) => {
      const sessions = m.getRepository(PlatformSession);
      const session = await sessions.findOne({ where: { tokenHash: hash } });
      if (!session) return refuse('Please sign in again.');

      const user = await m.getRepository(PlatformUser).findOne({ where: { id: session.platformUserId } });
      if (!user) return refuse('Please sign in again.');

      if (session.rotatedAt || session.revokedAt || session.expiresAt <= now) {
        if (session.rotatedAt || session.revokedAt) {
          await sessions.update(
            { family: session.family, revokedAt: IsNull() },
            { revokedAt: now, revokedReason: 'reuse detected' },
          );
          await this.record(m, 'session.reuse-detected', { userId: user.id, ctx });
        }
        return refuse('Please sign in again.');
      }

      if (user.status === 'suspended') return refuse('This account has been suspended.');

      await sessions.update(session.id, { rotatedAt: now });
      return allow(await this.startSession(m, user, ctx, now, session.family));
    });

    if (outcome.kind === 'refused') throw new UnauthorizedException(outcome.message);
    return outcome.value;
  }

  async signOut(refreshToken: string, now = new Date()): Promise<void> {
    const hash = this.passwords.fingerprint(refreshToken);
    await runTenantSpanning(this.ds, 'platform sign-out', async (m) => {
      const sessions = m.getRepository(PlatformSession);
      const session = await sessions.findOne({ where: { tokenHash: hash } });
      if (!session) return;
      await sessions.update(
        { family: session.family, revokedAt: IsNull() },
        { revokedAt: now, revokedReason: 'signed out' },
      );
      await this.record(m, 'session.signed-out', { userId: session.platformUserId, ctx: {} });
    });
  }

  /** Every way back in closes at once — used when a platform user is suspended. */
  async revokeAllFor(platformUserId: string, reason: string, now = new Date()): Promise<void> {
    await this.ds.getRepository(PlatformSession).update(
      { platformUserId, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: reason },
    );
  }

  /**
   * Creates the very first platform user, or any subsequent one. There is no HTTP
   * route for this today — see scripts/create-platform-user.ts, run from the
   * server's own shell, the same trust boundary `token:platform` always relied on.
   */
  async create(input: { email: string; fullName: string; role: PlatformRole; password: string }): Promise<PlatformUser> {
    const email = input.email.trim().toLowerCase();
    if (!PLATFORM_ROLES.includes(input.role)) {
      throw new Error(`"${input.role}" is not a platform role: ${PLATFORM_ROLES.join(', ')}`);
    }
    const passwordHash = this.passwords.hash(input.password, email);
    const repo = this.ds.getRepository(PlatformUser);
    const existing = await repo.findOne({ where: { email } });
    if (existing) throw new Error(`${email} already has a platform credential.`);
    return repo.save(repo.create({ email, fullName: input.fullName, role: input.role, passwordHash }));
  }

  // ----------------------------------------------------------------------- shared

  private async startSession(
    m: EntityManager, user: PlatformUser, ctx: RequestContext, now: Date, family?: string,
  ): Promise<SignInResult> {
    const refreshToken = this.passwords.newToken();
    await m.getRepository(PlatformSession).save(m.getRepository(PlatformSession).create({
      platformUserId: user.id,
      tokenHash: this.passwords.fingerprint(refreshToken),
      family: family ?? randomUUID(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000),
      userAgent: ctx.userAgent ?? null,
    }));

    const claim = this.config.get<string>('AUTH_TENANT_CLAIM') || 'client_id';
    const issuer = this.config.get<string>('AUTH_JWT_ISSUER') || undefined;
    // No `sub`-as-DB-id assumption anywhere downstream: the guard only ever reads
    // `roles` off a platform token (see this file's class comment), so `sub` here is
    // free to be the real platform_user.id, same as a tenant user's access token.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, [claim]: 'things-alive', roles: [user.role] },
      { secret: this.config.get<string>('AUTH_JWT_SECRET'), expiresIn: ACCESS_TOKEN_SECONDS, ...(issuer ? { issuer } : {}) },
    );

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: ACCESS_TOKEN_SECONDS,
      user: { id: user.id, email: user.email, fullName: user.fullName, tenantId: 'things-alive', roleSlug: user.role },
    };
  }

  private async record(
    m: EntityManager,
    type: SecurityEventType,
    opts: { userId?: string; emailAttempted?: string; ctx: RequestContext; detail?: string },
  ): Promise<void> {
    await m.getRepository(UserSecurityEvent).save(m.getRepository(UserSecurityEvent).create({
      tenantId: null,
      userId: opts.userId ?? null,
      emailAttempted: opts.emailAttempted ?? null,
      type,
      detail: opts.detail ?? null,
      ipAddress: opts.ctx.ipAddress ?? null,
      userAgent: opts.ctx.userAgent ?? null,
    }));
  }
}
