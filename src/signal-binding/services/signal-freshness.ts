/**
 * The resolution order for how old is too old (task Q08S s3): the tenant's
 * class copy's own `stale_after_seconds`, else the platform default. There is
 * no tenant copy of `equipment_class_sensor_requirement` to read instead —
 * `equipment_profile.class_version` already pins which immutable platform row
 * applies, which is the same guarantee a copy would exist to provide.
 */
export const DEFAULT_STALE_AFTER_SECONDS = 900;

export function resolveStaleAfterSeconds(requirement: { staleAfterSeconds: number | null } | null): number {
  return requirement?.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
}

/** The two reasons `coverage()` could not previously tell apart (its own doc
 * comment named this gap explicitly) — this is the "later, telemetry-aware
 * slice" it was waiting for. `no_readings` means never, not "none recently";
 * getting that backwards turns a quiet machine into a commissioning ticket. */
export function classifyFreshness(
  lastReadingAt: Date | null, at: Date, staleAfterSeconds: number,
): 'ready' | 'no_readings' | 'stale' {
  if (!lastReadingAt) return 'no_readings';
  const secondsSince = (at.getTime() - lastReadingAt.getTime()) / 1000;
  return secondsSince > staleAfterSeconds ? 'stale' : 'ready';
}
