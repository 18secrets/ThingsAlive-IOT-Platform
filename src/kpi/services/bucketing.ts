import { BadRequestException } from '@nestjs/common';

/**
 * The bucket-size ladder (task QCE2.1 §2) — a deterministic rule rather than a
 * per-chart guess, so two callers asking for the same window get the same
 * resolution and nobody has to remember why. Snapped to human units because a
 * chart labelled "every 437 seconds" is a chart nobody reads.
 *
 * Target is roughly 120 points; the ceiling is 200. Pick the *smallest* unit
 * (finest resolution) in the ladder whose bucket count still fits under that
 * ceiling — a 12h window lands on 5m buckets (144 points), 7d lands on 1h
 * (168), 30d lands on 6h (120). Reaching for a coarser bucket than the ladder
 * would otherwise land on is never correct; this only ever trades resolution
 * for staying under the ceiling.
 */
const BUCKET_LADDER_SECONDS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];
const MAX_BUCKETS_TARGET = 200;

/** An explicit override is refused past this many points, never truncated —
 * a silently truncated chart is a wrong chart (task QCE2.1 §2). */
export const MAX_BUCKETS_OVERRIDE = 1000;

export function pickBucketSeconds(windowSeconds: number, overrideSeconds?: number): number {
  if (overrideSeconds !== undefined) {
    const count = Math.ceil(windowSeconds / overrideSeconds);
    if (count > MAX_BUCKETS_OVERRIDE) {
      throw new BadRequestException(
        `A ${overrideSeconds}s bucket over this window produces ${count} points; `
          + `the limit is ${MAX_BUCKETS_OVERRIDE}. Refused rather than truncated.`,
      );
    }
    return overrideSeconds;
  }
  for (const candidate of BUCKET_LADDER_SECONDS) {
    if (Math.ceil(windowSeconds / candidate) <= MAX_BUCKETS_TARGET) return candidate;
  }
  return BUCKET_LADDER_SECONDS[BUCKET_LADDER_SECONDS.length - 1];
}
