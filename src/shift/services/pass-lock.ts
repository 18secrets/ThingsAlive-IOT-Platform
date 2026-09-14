import { DataSource } from 'typeorm';

/**
 * One scoring pass at a time across every instance (task P1-114).
 *
 * Two instances of the API running the same pass would both read the same watermark
 * and score the same shift. Nothing would be corrupted — a prediction is keyed by the
 * moment it describes and upserts, and a live automatic job is refused by a unique
 * index — but it doubles the work, and it halves the sense the logs make at exactly
 * the moment somebody is reading them to find out why a machine was not scored.
 *
 * A Postgres advisory lock rather than a table, because the thing being protected is
 * "somebody is doing this right now", not a row. It is held on one connection for the
 * duration of the pass and released when it ends; if the process dies the lock dies
 * with the connection, which is the behaviour a claim in a table has to reimplement
 * badly.
 *
 * Deliberately one lock for the whole pass rather than one per shift. Per-shift claims
 * scale further and are the right answer for a fleet large enough that a pass takes
 * longer than the interval between passes; at that point this becomes the bottleneck
 * and should be replaced. Until then, one lock is one thing to reason about.
 */
export const SHIFT_PASS_LOCK_KEY = 8_742_310_001;

export interface PassLock {
  release(): Promise<void>;
}

/**
 * Take the lock, or return null because somebody else has it.
 *
 * Never waits. A tick that arrives while the previous pass is still running has
 * nothing useful to add by queueing behind it — the work it would do is the work
 * already in progress, and the next tick will find whatever is left.
 */
export async function tryTakePassLock(
  ds: DataSource, key = SHIFT_PASS_LOCK_KEY,
): Promise<PassLock | null> {
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const [row] = await runner.query('SELECT pg_try_advisory_lock($1) AS taken', [key]);
    if (!row?.taken) {
      await runner.release();
      return null;
    }
  } catch (error) {
    await runner.release();
    throw error;
  }

  return {
    release: async () => {
      try {
        // Unlock on the same connection that locked, which is why the query runner is
        // held rather than the lock being taken through the pool.
        await runner.query('SELECT pg_advisory_unlock($1)', [key]);
      } finally {
        await runner.release();
      }
    },
  };
}
