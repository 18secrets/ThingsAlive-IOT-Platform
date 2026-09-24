import { BadRequestException, Injectable } from '@nestjs/common';
import { compareSync, hashSync } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Deliberately short. A serious check needs a real breached-password corpus, which is
 * a dependency and a decision of its own (P1-90); this stops the handful that would
 * otherwise be chosen on a Friday afternoon and does not pretend to be more.
 */
const OBVIOUS = new Set([
  'password', 'passw0rd', 'password123', 'password1234', '123456789012',
  'qwertyuiop', 'letmein12345', 'iloveyou1234', 'administrator', 'thingsalive',
  // The exact string composition rules push everybody towards: one of each
  // required class and nothing else. Without this, the class requirements
  // below would make this the single most common password on the platform.
  'password1!',
]);

/**
 * The cost factor, and the one number here worth revisiting on a schedule.
 *
 * Twelve is roughly a quarter of a second on current hardware, which is slow enough
 * to matter to somebody with a stolen hash table and fast enough that a login does
 * not feel broken. It should rise as hardware does, which is why every hash records
 * its own cost and verification reads it from the hash rather than from here.
 */
const COST = 12;

@Injectable()
export class PasswordService {
  /** Checks the policy, then hashes. Never one without the other. */
  hash(password: string, email?: string): string {
    this.assertAcceptable(password, email);
    return hashSync(password, COST);
  }

  verify(password: string, hash: string | null): boolean {
    // A null hash is an invited user who has never set one. It is not "any password
    // works" — it is "no password works", and saying so here means no caller has to
    // remember the difference.
    if (!hash) return false;
    return compareSync(password, hash);
  }

  assertAcceptable(password: string, email?: string): void {
    const value = password ?? '';
    if (value.length > 200) {
      // Not a strength rule. bcrypt ignores everything past 72 bytes, and an
      // unbounded input is a cheap way to make the server do work on request.
      throw new BadRequestException('That password is too long.');
    }
    if (!/[A-Z]/.test(value)) {
      throw new BadRequestException('A password needs at least one uppercase letter.');
    }
    if (!/[a-z]/.test(value)) {
      throw new BadRequestException('A password needs at least one lowercase letter.');
    }
    if (!/[0-9]/.test(value)) {
      throw new BadRequestException('A password needs at least one number.');
    }
    if (!/[^A-Za-z0-9]/.test(value)) {
      throw new BadRequestException('A password needs at least one special character.');
    }
    if (OBVIOUS.has(value.toLowerCase())) {
      throw new BadRequestException('That password is one of the first anybody tries.');
    }
    const local = email?.split('@')[0]?.toLowerCase();
    if (local && local.length > 2 && value.toLowerCase().includes(local)) {
      throw new BadRequestException('A password should not contain your own email address.');
    }
  }

  /** A token nobody has to remember, so it can be as long as it likes. */
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Tokens are stored as a fast hash rather than a slow one. They are 256 bits of
   * randomness, so there is nothing to guess and nothing for bcrypt's cost to defend
   * against — what matters is only that a database dump contains no usable token.
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
