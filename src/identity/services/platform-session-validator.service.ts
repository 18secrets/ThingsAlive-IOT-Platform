import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlatformSessionValidator } from '../../auth/platform-session-validator';
import { PlatformSession } from '../entities/platform-session.entity';
import { PlatformUser } from '../entities/platform-user.entity';

/**
 * The database half of `PlatformSessionValidator` — what the guard asks on every
 * request that carries a session-backed platform token.
 *
 * Neither table is tenant-scoped, so this reads with the plain `DataSource` rather
 * than `withTenantId`, the same reason `PlatformCredentialService` does.
 */
@Injectable()
export class PlatformSessionValidatorService implements PlatformSessionValidator {
  constructor(private readonly ds: DataSource) {}

  async isSessionUsable(sessionId: string): Promise<boolean> {
    const session = await this.ds.getRepository(PlatformSession).findOne({ where: { id: sessionId } });
    if (!session || session.revokedAt) return false;

    const user = await this.ds.getRepository(PlatformUser).findOne({ where: { id: session.platformUserId } });
    return !!user && user.status !== 'suspended';
  }
}
