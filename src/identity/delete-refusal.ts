import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/** The refusals the `delete_unused_*` functions raise, already worded for the person who asked. */
const GUARDS = new Set([
  'ck_delete_never_signed_in',
  'ck_app_user_ceo_manager_retained',
  'ck_delete_tenant_suspended',
  'ck_delete_tenant_unused',
]);

/**
 * A delete the database refused, as the 400 or 409 it deserves. The rules live in
 * the functions (`DeleteGuards1759600000000`), which are the only way the application
 * can delete these rows, so this is where every refusal arrives.
 */
export function rethrowDeleteRefusal(err: unknown, referenced = 'Other records still point at this, so it cannot be deleted.'): never {
  if (err instanceof QueryFailedError) {
    const { code, constraint } = err as QueryFailedError & { code?: string; constraint?: string };
    if (code === '23514' && constraint && GUARDS.has(constraint)) throw new BadRequestException(err.message);
    if (code === '23503') throw new ConflictException(referenced);
  }
  throw err;
}
