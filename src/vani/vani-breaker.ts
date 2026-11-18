/** Failures in a row, across passes, before Vani is left alone for a while. */
export const BREAKER_THRESHOLD = 3;
/** How long Vani is left alone once the breaker opens. */
export const BREAKER_COOLDOWN_MS = 2 * 60 * 1000;

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Whether it is worth contacting Vani right now. One per process, shared by the call
 * sender and the snapshot pusher, because they reach the same service and an outage
 * takes both down together.
 *
 * Without it, an outage costs every due request a 10-second timeout on every pass, one
 * after another, and spends one of each request's five attempts on finding out what
 * the first one already showed. Open, nothing is claimed, so nothing waiting loses an
 * attempt to an outage it could not have got through. After the cooldown one request
 * goes through as a probe: an answer closes the breaker, a failure opens it again.
 *
 * A failure is not reaching Vani, or Vani answering 5xx, 429 or 401. A 401 is our token,
 * not Vani's health, but every request will be refused the same way until somebody
 * fixes it, so trying them all only fills the log. Any other answer, a 422 included,
 * means Vani is up and listening.
 *
 * In memory, so a restart closes it again. The worst that costs is one more probe.
 */
export class VaniBreaker {
  private failures = 0;
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly threshold = BREAKER_THRESHOLD,
    private readonly cooldownMs = BREAKER_COOLDOWN_MS,
  ) {}

  state(now = new Date()): BreakerState {
    if (this.openUntil === 0) return 'closed';
    return now.getTime() < this.openUntil ? 'open' : 'half-open';
  }

  /** True when a request may go out now. While half-open, only one at a time. */
  allows(now = new Date()): boolean {
    const s = this.state(now);
    if (s === 'closed') return true;
    if (s === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  /** The request let through went nowhere near Vani (nothing due, or settled locally). */
  release(): void {
    this.probing = false;
  }

  succeeded(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  failed(now = new Date()): void {
    this.failures += 1;
    const wasProbe = this.probing;
    this.probing = false;
    if (wasProbe || this.failures >= this.threshold) this.openUntil = now.getTime() + this.cooldownMs;
  }

  /** Whether an HTTP answer says Vani is unwell (or will refuse everything alike). */
  static isFailure(status: number): boolean {
    return status >= 500 || status === 429 || status === 401;
  }
}
