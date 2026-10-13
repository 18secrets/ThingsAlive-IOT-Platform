import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, Not, QueryFailedError } from 'typeorm';
import { AppUser } from './entities/app-user.entity';

/**
 * A phone number as stored: spaces, dashes, dots and brackets removed, an optional
 * leading +, then 10 to 15 digits (dashboard testing, issue 1). "98765 49878" and
 * "9876549878" are one number, and stored one way so the uniqueness rule can see it.
 * Blank means none.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/[\s\-().]/g, '');
  if (!value) return null;
  if (!/^\+?[0-9]{10,15}$/.test(value)) {
    throw new BadRequestException(`"${raw.trim()}" is not a phone number. Use 10 to 15 digits, optionally starting with +.`);
  }
  return value;
}

/**
 * Whether somebody else already has this number. A phone identifies a person the
 * same way an email does, so it is unique across the platform, not per account.
 * Tenant-spanning for the same reason as `loginEmailTaken`: a check scoped to one
 * account cannot see the others. The database (`PhoneUnclaimed1759700000000`) is what
 * actually refuses; this is the polite check in front of it.
 */
export async function phoneTaken(m: EntityManager, phone: string | null, exceptUserId?: string): Promise<boolean> {
  if (!phone) return false;
  return m.getRepository(AppUser).exists({
    where: exceptUserId ? { phone, id: Not(exceptUserId) } : { phone },
  });
}

export const phoneTakenError = (phone: string): ConflictException =>
  new ConflictException(`${phone} already belongs to somebody else.`);

/** The trigger's refusal, for the request that lost a race to the same number. */
export function isPhoneClash(err: unknown): boolean {
  const { code, constraint } = err as { code?: string; constraint?: string };
  return err instanceof QueryFailedError && code === '23505' && constraint === 'uq_app_user_phone';
}
