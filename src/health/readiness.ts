import { DataSource } from 'typeorm';

/**
 * What /ready is allowed to say, and what each answer costs (task D-04).
 *
 * This endpoint is not documentation. Railway holds a release at the old version
 * until it answers 200, so a readiness probe that always says "ok" is worse than no
 * probe at all: it converts a deployment gate into a deployment rubber stamp, and a
 * release that cannot reach its database sails through and takes traffic.
 *
 * Which is exactly what this endpoint did before this task — it returned a hardcoded
 * `status: 'ok'` with `database: 'not_configured'` written next to it, months after
 * the database was configured.
 */
export type CheckState = 'ok' | 'unreachable' | 'not_configured';
export type Readiness = 'ok' | 'degraded' | 'not_ready';

export interface ReadinessChecks {
  /** The platform's own database. Without it 2.0 can serve nothing. */
  database: CheckState;
  /**
   * The read-only connection to the existing platform. Optional by design: without
   * it every shift window stays owed and is scored when a route appears, so its
   * absence degrades the platform rather than stopping it.
   */
  legacy: CheckState;
}

/**
 * Only the platform's own database can fail a release.
 *
 * Deliberately not the legacy connection. Gating 2.0's deployments on somebody
 * else's database means their maintenance window blocks our releases, and the thing
 * we would be protecting — scoring — is already designed to wait and catch up.
 */
export const REQUIRED_CHECKS: (keyof ReadinessChecks)[] = ['database'];

/** Longer than a healthy round trip, far shorter than the platform healthcheck. */
export const PROBE_TIMEOUT_MS = 2_000;

export function summarise(checks: ReadinessChecks): Readiness {
  for (const key of REQUIRED_CHECKS) {
    // `not_configured` is not a failure here: it means the process was built without
    // a database, which specs do and production cannot — a missing DB_HOST fails env
    // validation at boot, so an unconfigured database never reaches a running server.
    if (checks[key] === 'unreachable') return 'not_ready';
  }
  return Object.values(checks).every((state) => state === 'ok') ? 'ok' : 'degraded';
}

export const STATUS_CODE: Record<Readiness, number> = {
  ok: 200,
  degraded: 200,
  not_ready: 503,
};

/**
 * One round trip, bounded. A probe that hangs is indistinguishable to the platform
 * from one that fails, except that it fails slower and takes the healthcheck window
 * with it — so the timeout is the answer, not a safeguard against one.
 */
export async function probe(
  ds: DataSource | null | undefined,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CheckState> {
  if (!ds) return 'not_configured';
  if (!ds.isInitialized) return 'unreachable';

  let timer: NodeJS.Timeout | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness probe timed out')), timeoutMs);
      // The probe must never be the reason a process stays alive.
      timer.unref?.();
    });
    await Promise.race([ds.query('SELECT 1'), expired]);
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
