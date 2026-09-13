import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ShiftRunner } from './shift-runner.service';

/** How often a pass is attempted. Not how often a shift is scored. */
export const DEFAULT_TICK_SECONDS = 300;

/**
 * The thing that makes any of this happen without somebody asking (task P1-114).
 *
 * A timer rather than a cron expression, because there is nothing to express. A shift
 * does not end at a fixed hour across a platform — it ends at 14:00 in one plant's
 * timezone and 06:00 in another's, on days each customer chose. The schedule lives in
 * `equipment_shift` and is read on every pass; this only decides how often to look.
 *
 * Five minutes is a latency, not a frequency: it is the longest a finished shift waits
 * before anybody looks at it, and a pass that finds nothing owed is two queries. The
 * cost of looking often is small and the cost of looking rarely is a customer watching
 * a machine they know finished an hour ago.
 *
 * Deliberately not a dependency. `@nestjs/schedule` would bring a cron parser and a
 * registry to express "every five minutes", which `setInterval` already says, and the
 * part that is actually hard — not running two passes at once — is a lock rather than
 * a scheduler.
 *
 * Off by default. A scheduled job that starts itself in every environment is a
 * scheduled job that runs during somebody's migration, in a test, and on a developer's
 * laptop pointed at production data.
 */
@Injectable()
export class ShiftScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly runner: ShiftRunner) {}

  onModuleInit(): void {
    if (`${process.env.SHIFT_RUNNER_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log(
        'SHIFT_RUNNER_ENABLED is not true, so nothing is scheduled. Shifts will be '
        + 'owed and scored the moment it is switched on.',
      );
      return;
    }
    const seconds = Math.max(30, Number(process.env.SHIFT_RUNNER_TICK_SECONDS ?? DEFAULT_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // Node keeps the process alive for a pending timer, which would hold a container
    // open through a shutdown that is otherwise complete.
    this.timer.unref?.();
    this.logger.log(`Scoring pass every ${seconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One tick.
   *
   * Guarded twice, against two different things. `running` stops this instance
   * overlapping itself when a pass takes longer than the interval; the advisory lock
   * inside the runner stops two instances overlapping each other. Either guard alone
   * leaves one of those cases open.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous pass still running. Skipping this tick.');
      return;
    }
    this.running = true;
    try {
      const summary = await this.runner.runExclusively(now);
      if (!summary || summary.considered === 0) return;
      this.logger.log(
        `Pass: ${summary.scored} scored, ${summary.idle} idle, ${summary.skipped} skipped, `
        + `${summary.failed} failed, ${summary.rewound} rewound.`,
      );
    } catch (error) {
      // A timer whose callback throws takes nothing down and reports nothing, which
      // is how a scheduled job stops silently. Caught, logged, and the next tick runs.
      this.logger.error(`Scoring pass failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
