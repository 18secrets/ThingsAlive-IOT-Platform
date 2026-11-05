import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * How a call from Vani proves itself: the outcome callback and the analysis tool both
 * arrive with no user token behind them, so both carry a shared secret in
 * `X-Vani-Secret`, compared with VANI_CALLBACK_SECRET.
 *
 * Unset, every such call is refused. An open endpoint that writes call history, or
 * answers questions about a customer's machines, is worse than a missing one.
 */
export function checkVaniSecret(presented: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const expected = `${env.VANI_CALLBACK_SECRET ?? ''}`.trim();
  if (!expected) throw new ServiceUnavailableException('Calls from Vani are not configured: VANI_CALLBACK_SECRET is unset.');
  // Compared as digests, so the comparison takes the same time whatever the length.
  const a = createHash('sha256').update(`${presented ?? ''}`).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new UnauthorizedException('Wrong or missing X-Vani-Secret.');
}
