import { Severity } from '../common/severity';
import { VaniSeverity } from './vani.entities';

/**
 * Our five severities onto Vani's three, in one place (integration guide §6.1).
 *
 * The mapping decides who gets woken up: Vani phones `critical` at any hour, holds
 * `warning` until business hours in the customer's timezone, and never phones `info`.
 *
 * `high` is not settled yet. VANI_HIGH_SEVERITY carries the answer until it is, and
 * defaults to `warning`: the mistake that phones nobody overnight is recoverable in
 * the morning; the one that phones a customer at 3 AM for something that could wait
 * is not.
 */
export function vaniSeverity(ours: Severity, env: NodeJS.ProcessEnv = process.env): VaniSeverity {
  switch (ours) {
    case Severity.Critical:
      return 'critical';
    case Severity.High:
      return highSetting(env);
    case Severity.Medium:
    case Severity.Low:
      return 'warning';
    case Severity.None:
      return 'info';
    default:
      // A sixth severity added later must be mapped here on purpose, not fall through
      // to a guess that phones somebody, or fails to.
      throw new Error(`No Vani severity for "${ours as string}".`);
  }
}

function highSetting(env: NodeJS.ProcessEnv): VaniSeverity {
  const raw = `${env.VANI_HIGH_SEVERITY ?? ''}`.trim().toLowerCase();
  if (raw === '') return 'warning';
  if (raw === 'critical' || raw === 'warning') return raw;
  throw new Error(`VANI_HIGH_SEVERITY must be "critical" or "warning", not "${raw}".`);
}
