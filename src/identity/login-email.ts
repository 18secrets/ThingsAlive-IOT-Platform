import { ConflictException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import { AppUser } from './entities/app-user.entity';
import { PlatformUser } from './entities/platform-user.entity';

/**
 * Whether an email already signs somebody in — as a client user or as staff.
 *
 * The database is what actually refuses a clash (`LoginEmailUnclaimed1759500000000`).
 * This is the polite check in front of it, so the usual case gets a 409 before
 * anything is written rather than after half an account exists. It must run in a
 * tenant-spanning transaction: `app_user` is behind row-level security, and a check
 * scoped to one tenant cannot see the other accounts it is asking about.
 */
export async function loginEmailTaken(m: EntityManager, email: string): Promise<boolean> {
  const [client, staff] = await Promise.all([
    m.getRepository(AppUser).exists({ where: { email } }),
    m.getRepository(PlatformUser).exists({ where: { email } }),
  ]);
  return client || staff;
}

/**
 * The trigger's refusal as the same 409 the polite check gives. It only fires when
 * two writes for one address raced past the check together, and the person who lost
 * that race is owed the same answer as one who arrived second.
 */
export function rethrowLoginEmailClash(err: unknown, email: string): never {
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint;
  if (err instanceof QueryFailedError && code === '23505' && constraint === 'uq_login_email') {
    throw new ConflictException(`${email} already has a login.`);
  }
  throw err;
}
