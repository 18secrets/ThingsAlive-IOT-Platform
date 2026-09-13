import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager, IsNull, LessThan, Not } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantId } from '../../scope/tenant-session';
import { AppUser } from '../entities/app-user.entity';
import { InvitationPurpose, UserInvitation } from '../entities/user-invitation.entity';
import { UserSecurityEvent, SecurityEventType } from '../entities/user-security-event.entity';
import { UserSession } from '../entities/user-session.entity';
import { PasswordService } from './password.service';

export interface SignInResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: { id: string; email: string; fullName: string; tenantId: string; roleSlug: string };
}

/**
 * A refusal carried out of a transaction rather than thrown inside one.
 *
 * Throwing inside `runTenantSpanning` rolls the transaction back, which takes the
 * evidence with it: the failed-login record, the incremented attempt counter, the
 * revocation of a stolen token family. Every one of those is written precisely
 * *because* the request is about to be refused, so they cannot live in a transaction
 * that the refusal aborts. The outcome is returned, committed, and thrown afterwards.
 */
type Refusal = { kind: 'refused'; message: string };
type Allowed<T> = { kind: 'allowed'; value: T };
type Outcome<T> = Allowed<T> | Refusal;

// Tagged with a string rather than a boolean on purpose. This project compiles with
// `strictNullChecks` off, and under that setting TypeScript does not narrow a union
// discriminated by `true`/`false` — the refusal branch type-checks as though it could
// still be the success branch. A string tag narrows correctly either way. Turning the
// flag on is worth doing (P1-91) and is not this slice's job.
const refuse = (message: string): Refusal => ({ kind: 'refused', message });
const allow = <T>(value: T): Allowed<T> => ({ kind: 'allowed', value });

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** An hour. Short because revoking one is impossible; the refresh token is the handle. */
export const ACCESS_TOKEN_SECONDS = 3600;
const REFRESH_TOKEN_DAYS = 30;
const INVITATION_DAYS = 14;
const RESET_HOURS = 2;

/** Five, then fifteen minutes. Enough to stop online guessing, not enough to be a weapon. */
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Signing in (task P1-88).
 *
 * Two tokens rather than one, and that is the whole point of the design. The existing
 * platform issues a single token that lasts a year and carries the user record inside
 * it; anything stolen from a browser is good for twelve months and nothing can be
 * done about it. Here the access token lasts an hour and the refresh token is a row
 * that can be revoked.
 *
 * Refresh tokens rotate on every use. Presenting a retired one means somebody has a
 * copy — the legitimate holder would have the replacement — so the entire family
 * descending from that sign-in is revoked at once. It is the only moment a stolen
 * token is ever detectable, and it costs one column.
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------------- invitations

  /**
   * Mint a token for somebody to set their password with.
   *
   * The plaintext is returned once and never stored. Whoever calls this is
   * responsible for putting it in front of the right person; the platform keeps only
   * enough to recognise it coming back.
   */
  async issueInvitation(
    scope: RequestScope, userId: string, purpose: InvitationPurpose = 'invite', now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    return withTenantId(this.ds, scope.tenantId, async (m) => {
      const user = await m.getRepository(AppUser).findOne({
        where: { tenantId: scope.tenantId, id: userId },
      });
      if (!user) throw new BadRequestException('No such person in this account.');

      return this.mint(m, user, purpose, scope.userId, now);
    });
  }

  private async mint(
    m: EntityManager, user: AppUser, purpose: InvitationPurpose, by: string | null, now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const repo = m.getRepository(UserInvitation);

    // Outstanding tokens for the same purpose are retired first. Two live invitations
    // means the older email still works, which is exactly what somebody re-sending an
    // invitation because the first went astray is trying to prevent.
    await repo.update(
      { tenantId: user.tenantId, userId: user.id, purpose, consumedAt: IsNull() },
      { consumedAt: now },
    );

    const token = this.passwords.newToken();
    const expiresAt = new Date(now.getTime() + (purpose === 'invite'
      ? INVITATION_DAYS * 86_400_000
      : RESET_HOURS * 3_600_000));

    await repo.save(repo.create({
      tenantId: user.tenantId, userId: user.id,
      tokenHash: this.passwords.fingerprint(token),
      purpose, expiresAt, consumedAt: null, createdBy: by,
    }));
    return { token, expiresAt };
  }

  /**
   * Set a password with a token, and sign in.
   *
   * The token is consumed in the same transaction as the password is written, so a
   * failure part-way leaves it usable rather than leaving somebody locked out of an
   * account they just set a password on.
   */
  async acceptInvitation(
    token: string, password: string, ctx: RequestContext = {}, now = new Date(),
  ): Promise<SignInResult> {
    const hash = this.passwords.fingerprint(token);

    return runTenantSpanning(this.ds, 'invitation acceptance', async (m) => {
      const invitation = await m.getRepository(UserInvitation).findOne({ where: { tokenHash: hash } });
      // One message for missing, consumed and expired. Which of the three it is tells
      // whoever is guessing something, and tells the rightful holder nothing they can
      // act on beyond "ask for another".
      if (!invitation || invitation.consumedAt || invitation.expiresAt <= now) {
        throw new UnauthorizedException('That link is no longer valid. Ask for a new one.');
      }

      const repo = m.getRepository(AppUser);
      const user = await repo.findOne({ where: { id: invitation.userId } });
      if (!user) throw new UnauthorizedException('That link is no longer valid. Ask for a new one.');
      if (user.status === 'suspended') {
        throw new UnauthorizedException('This account has been suspended.');
      }

      user.passwordHash = this.passwords.hash(password, user.email);
      user.status = 'active';
      user.activatedAt = user.activatedAt ?? now;
      user.failedAttempts = 0;
      user.lockedUntil = null;
      await repo.save(user);

      invitation.consumedAt = now;
      await m.getRepository(UserInvitation).save(invitation);

      // Every existing session dies. Setting a password is what somebody does when
      // they believe one is compromised, and leaving old sessions alive would make
      // the act useless in exactly that case.
      await this.revokeAll(m, user, 'password changed', now);
      await this.record(m, 'password.set', { user, ctx, detail: invitation.purpose });

      return this.startSession(m, user, ctx, now);
    });
  }

  // ------------------------------------------------------------------------- login

  async signIn(
    email: string, password: string, ctx: RequestContext = {}, now = new Date(),
  ): Promise<SignInResult> {
    const normalised = email.trim().toLowerCase();

    const outcome = await runTenantSpanning<Outcome<SignInResult>>(this.ds, 'sign-in', async (m) => {
      const repo = m.getRepository(AppUser);
      const user = await repo.findOne({ where: { email: normalised } });

      if (!user) {
        // Recorded with no tenant and no user: an address nobody has is precisely the
        // attempt worth counting, and it can be attributed to no account by definition.
        await this.record(m, 'login.failed', {
          ctx, email: normalised, detail: 'no such address',
        });
        return refuse('Email or password is incorrect.');
      }

      if (user.lockedUntil && user.lockedUntil > now) {
        const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
        await this.record(m, 'login.failed', { user, ctx, detail: 'locked' });
        // This does tell a stranger the address exists. The trade is deliberate: the
        // alternative is a locked-out employee who cannot tell a wrong password from a
        // lockout, which ends in a support call and a password reset — worse for
        // security than the small signal given up here. Reaching this state also costs
        // an attacker five failed attempts per address, which is itself the throttle.
        return refuse(
          `Too many failed attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
        );
      }

      if (!this.passwords.verify(password, user.passwordHash)) {
        user.failedAttempts = (user.failedAttempts ?? 0) + 1;
        if (user.failedAttempts >= MAX_FAILURES) {
          user.lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000);
          user.failedAttempts = 0;
          await repo.save(user);
          await this.record(m, 'login.locked', { user, ctx });
        } else {
          await repo.save(user);
          await this.record(m, 'login.failed', { user, ctx, detail: 'wrong password' });
        }
        return refuse('Email or password is incorrect.');
      }

      // Checked after the password, for the same reason the user's own status is:
      // before it, this branch would answer "does anybody at this company use the
      // platform" to anybody who asked.
      const tenant = await m.getRepository(Tenant).findOne({ where: { tenantId: user.tenantId } });
      if (tenant && tenant.status === 'suspended') {
        await this.record(m, 'login.failed', { user, ctx, detail: 'tenant suspended' });
        return refuse('This organisation\'s account is suspended. Please contact Things Alive.');
      }

      // Checked after the password, on purpose. Before it, this branch would answer
      // "is there a suspended account at this address" to anybody who asked.
      if (user.status === 'suspended') {
        await this.record(m, 'login.failed', { user, ctx, detail: 'suspended' });
        return refuse('This account has been suspended. Your administrator can restore it.');
      }
      if (user.status === 'invited' || !user.passwordHash) {
        return refuse('This invitation has not been accepted yet.');
      }

      user.failedAttempts = 0;
      user.lockedUntil = null;
      await repo.save(user);
      await this.record(m, 'login.succeeded', { user, ctx });

      return allow(await this.startSession(m, user, ctx, now));
    });

    if (outcome.kind === 'refused') throw new UnauthorizedException(outcome.message);
    return outcome.value;
  }

  // ---------------------------------------------------------------------- sessions

  async refresh(
    refreshToken: string, ctx: RequestContext = {}, now = new Date(),
  ): Promise<SignInResult> {
    const hash = this.passwords.fingerprint(refreshToken);

    const outcome = await runTenantSpanning<Outcome<SignInResult>>(this.ds, 'session refresh', async (m) => {
      const sessions = m.getRepository(UserSession);
      const session = await sessions.findOne({ where: { tokenHash: hash } });
      if (!session) return refuse('Please sign in again.');

      const user = await m.getRepository(AppUser).findOne({ where: { id: session.userId } });
      if (!user) return refuse('Please sign in again.');

      // A token that has already been rotated or revoked is being presented by
      // somebody who should not have it — the rightful holder has the replacement. It
      // is the only moment a stolen refresh token is detectable, so the whole family
      // goes, which throws out both the thief and the victim. The victim signs in
      // again; the thief cannot.
      if (session.rotatedAt || session.revokedAt || session.expiresAt <= now) {
        if (session.rotatedAt || session.revokedAt) {
          await sessions.update(
            { family: session.family, revokedAt: IsNull() },
            { revokedAt: now, revokedReason: 'reuse detected' },
          );
          await this.record(m, 'session.reuse-detected', { user, ctx, detail: session.family });
        }
        return refuse('Please sign in again.');
      }

      if (user.status !== 'active') {
        await this.revokeAll(m, user, `status ${user.status}`, now);
        return refuse('This account can no longer sign in.');
      }

      session.rotatedAt = now;
      await sessions.save(session);
      await this.record(m, 'session.refreshed', { user, ctx });

      return allow(await this.startSession(m, user, ctx, now, session.family));
    });

    if (outcome.kind === 'refused') throw new UnauthorizedException(outcome.message);
    return outcome.value;
  }

  async signOut(refreshToken: string, now = new Date()): Promise<void> {
    const hash = this.passwords.fingerprint(refreshToken);
    await runTenantSpanning(this.ds, 'sign-out', async (m) => {
      const sessions = m.getRepository(UserSession);
      const session = await sessions.findOne({ where: { tokenHash: hash } });
      if (!session) return;
      // The family, not the row. Signing out on one device should not leave a
      // refresh chain alive that the same sign-in produced.
      await sessions.update(
        { family: session.family, revokedAt: IsNull() },
        { revokedAt: now, revokedReason: 'signed out' },
      );
      await this.record(m, 'session.signed-out', { userId: session.userId, tenantId: session.tenantId });
    });
  }

  /** Used when somebody is suspended: every way back in closes at once. */
  async revokeAllFor(tenantId: string, userId: string, reason: string, now = new Date()): Promise<void> {
    await runTenantSpanning(this.ds, `revoke sessions: ${reason}`, async (m) => {
      await m.getRepository(UserSession).update(
        { tenantId, userId, revokedAt: IsNull() },
        { revokedAt: now, revokedReason: reason },
      );
      await this.record(m, 'session.revoked', { tenantId, userId, detail: reason });
    });
  }

  // -------------------------------------------------------------------- resetting

  /**
   * Always the same answer.
   *
   * This is the one place where refusing to say whether an address exists costs
   * nothing: the person who owns it gets an email, and the person who does not learns
   * nothing. A different response for an unknown address would turn this into a way
   * to enumerate every customer's staff list.
   */
  async requestReset(email: string, ctx: RequestContext = {}, now = new Date()): Promise<{ token?: string }> {
    const normalised = email.trim().toLowerCase();

    return runTenantSpanning(this.ds, 'password reset request', async (m) => {
      const user = await m.getRepository(AppUser).findOne({ where: { email: normalised } });
      if (!user || user.status === 'suspended') {
        await this.record(m, 'password.reset-requested', {
          ctx, email: normalised, detail: 'no eligible account',
        });
        return {};
      }
      await this.record(m, 'password.reset-requested', { user, ctx });
      const { token } = await this.mint(m, user, 'reset', null, now);
      // Returned for the caller that sends the email. The route does not expose it.
      return { token };
    });
  }

  // ----------------------------------------------------------------------- shared

  private async startSession(
    m: EntityManager, user: AppUser, ctx: RequestContext, now: Date, family?: string,
  ): Promise<SignInResult> {
    const refreshToken = this.passwords.newToken();
    const sessions = m.getRepository(UserSession);
    await sessions.save(sessions.create({
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: this.passwords.fingerprint(refreshToken),
      family: family ?? randomUUID(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000),
      rotatedAt: null, revokedAt: null, revokedReason: null,
      userAgent: ctx.userAgent ?? null,
    }));

    const claim = this.config.get<string>('AUTH_TENANT_CLAIM') || 'client_id';
    // Deliberately thin. The existing platform puts the whole user record in its
    // token, which is how a year-old token still describes somebody's job; everything
    // beyond identity is resolved per request from the account's own tables.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, [claim]: user.tenantId },
      {
        secret: this.config.get<string>('AUTH_JWT_SECRET'),
        expiresIn: ACCESS_TOKEN_SECONDS,
        ...(this.config.get<string>('AUTH_JWT_ISSUER')
          ? { issuer: this.config.get<string>('AUTH_JWT_ISSUER') }
          : {}),
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: ACCESS_TOKEN_SECONDS,
      user: {
        id: user.id, email: user.email, fullName: user.fullName,
        tenantId: user.tenantId, roleSlug: user.roleSlug,
      },
    };
  }

  private async revokeAll(m: EntityManager, user: AppUser, reason: string, now: Date): Promise<void> {
    await m.getRepository(UserSession).update(
      { tenantId: user.tenantId, userId: user.id, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: reason },
    );
  }

  private async record(
    m: EntityManager,
    type: SecurityEventType,
    what: {
      user?: AppUser; userId?: string; tenantId?: string | null;
      email?: string; detail?: string | null; ctx?: RequestContext;
    },
  ): Promise<void> {
    const repo = m.getRepository(UserSecurityEvent);
    await repo.save(repo.create({
      tenantId: what.user?.tenantId ?? what.tenantId ?? null,
      userId: what.user?.id ?? what.userId ?? null,
      emailAttempted: what.email ?? null,
      type,
      detail: what.detail ?? null,
      ipAddress: what.ctx?.ipAddress ?? null,
      userAgent: what.ctx?.userAgent ?? null,
    }));
  }

  /** Housekeeping: consumed and expired rows are evidence for a while, then noise. */
  async prune(before: Date): Promise<{ invitations: number; sessions: number }> {
    return runTenantSpanning(this.ds, 'credential housekeeping', async (m) => {
      const invitations = await m.getRepository(UserInvitation).delete({
        expiresAt: LessThan(before), consumedAt: Not(IsNull()),
      });
      const sessions = await m.getRepository(UserSession).delete({ expiresAt: LessThan(before) });
      return { invitations: invitations.affected ?? 0, sessions: sessions.affected ?? 0 };
    });
  }
}
