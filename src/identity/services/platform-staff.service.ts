import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlatformRole } from '../../auth/platform-roles';
import { PlatformUser, PlatformUserStatus } from '../entities/platform-user.entity';
import { PlatformCredentialService } from './platform-credential.service';

export interface InviteStaffInput {
  email: string;
  fullName: string;
  role: PlatformRole;
}

/** Never the password hash — this is what the staff list and every mutation return. */
export interface PlatformStaffView {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: PlatformUserStatus;
  invitedBy: string | null;
  invitedAt: Date | null;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Lower-cased and trimmed once, here — the same convention as `normaliseEmail` in `user.service.ts`. */
const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

/**
 * Things Alive's own people (task QPA2) — `PlatformUser`'s counterpart to
 * `UserService`.
 *
 * Inviting is the only way a platform user is created after `staff:bootstrap`'s one
 * run: that script refuses outright once any row exists, on purpose, so every
 * account after the first is issued by somebody already signed in and accountable
 * for it, not a shell script run again.
 *
 * The row and the token that lets somebody claim it are different concerns, the
 * same split `IdentityController` keeps between `UserService` and
 * `CredentialService` — this composes `PlatformCredentialService` for the token
 * rather than minting one itself.
 */
@Injectable()
export class PlatformStaffService {
  constructor(
    private readonly ds: DataSource,
    private readonly credentials: PlatformCredentialService,
  ) {}

  async list(): Promise<PlatformStaffView[]> {
    const users = await this.ds.getRepository(PlatformUser).find({ order: { fullName: 'ASC' } });
    return users.map((u) => this.view(u));
  }

  async invite(input: InviteStaffInput, by: string, now = new Date()): Promise<PlatformStaffView> {
    const email = normaliseEmail(input.email);
    const repo = this.ds.getRepository(PlatformUser);

    // Same uniqueness question `mint-token.ts`/`create()` never had to ask, because
    // neither took an email at all — this is the first path where two invitations
    // could otherwise land on the same address.
    const existing = await repo.findOne({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictException(`${email} already has a platform credential.`);

    const user = await repo.save(repo.create({
      email, fullName: input.fullName.trim(), role: input.role,
      status: 'invited', passwordHash: null,
      invitedBy: by, invitedAt: now, activatedAt: null,
    }));
    return this.view(user);
  }

  async setRole(id: string, role: PlatformRole): Promise<PlatformStaffView> {
    const repo = this.ds.getRepository(PlatformUser);
    const user = await repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('No such platform user.');

    user.role = role;
    return this.view(await repo.save(user));
  }

  /**
   * Suspend rather than delete, the same reason `UserService.suspend` does: everything
   * this person did still names them. Every live session dies too, through
   * `PlatformCredentialService.revokeAllFor` rather than a second query against
   * `platform_session` here — the guard would refuse them on the next request anyway
   * (it re-checks `status` per request), but a refresh token left valid is a way back
   * in the moment somebody is reinstated by mistake.
   */
  async suspend(id: string, reason: string, now = new Date()): Promise<PlatformStaffView> {
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to suspend somebody.');
    }
    const repo = this.ds.getRepository(PlatformUser);
    const user = await repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('No such platform user.');

    user.status = 'suspended';
    user.suspendedAt = now;
    user.suspendedReason = reason;
    const saved = await repo.save(user);
    await this.credentials.revokeAllFor(id, 'suspended', now);
    return this.view(saved);
  }

  async reinstate(id: string): Promise<PlatformStaffView> {
    const repo = this.ds.getRepository(PlatformUser);
    const user = await repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('No such platform user.');

    // Somebody who never accepted their invitation goes back to invited, not active:
    // the invitation is still what is outstanding. Mirrors UserService.setStatus.
    user.status = user.passwordHash ? 'active' : 'invited';
    user.suspendedAt = null;
    user.suspendedReason = null;
    return this.view(await repo.save(user));
  }

  private view(user: PlatformUser): PlatformStaffView {
    return {
      id: user.id, email: user.email, fullName: user.fullName, role: user.role, status: user.status,
      invitedBy: user.invitedBy, invitedAt: user.invitedAt, activatedAt: user.activatedAt,
      suspendedAt: user.suspendedAt, suspendedReason: user.suspendedReason,
      createdAt: user.createdAt, updatedAt: user.updatedAt,
    };
  }
}
