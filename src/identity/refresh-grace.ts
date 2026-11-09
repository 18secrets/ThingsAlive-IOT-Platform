/**
 * How long a refresh token that has just been rotated may be presented again without
 * being taken for a stolen one (test report MAJ-5, "signed out after a few reloads").
 *
 * Rotation treats a second use of a token as theft and revokes the whole sign-in. On
 * Development that fired 239 times, and 90 of them came under two seconds after the
 * same person's successful refresh: the console sends two refreshes with one token as
 * a page loads, or a reload unloads the page before the new token is saved. Both are the
 * rightful holder, and both were signed out of every tab.
 *
 * Inside the window the old token gets a token of its own in the same sign-in, and
 * nothing is revoked. Outside it, reuse is theft as before. A minute is the usual
 * "reuse interval": long enough for a slow reload on a site's mobile data, short enough
 * that a token lifted from a laptop is useless by the time anyone could use it.
 */
export const REFRESH_REUSE_GRACE_MS = 60_000;

export function rotatedWithinGrace(rotatedAt: Date | null, revokedAt: Date | null, now: Date): boolean {
  return !!rotatedAt && !revokedAt && now.getTime() - rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
}
