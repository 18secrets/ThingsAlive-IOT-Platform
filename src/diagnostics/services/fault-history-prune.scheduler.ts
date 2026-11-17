import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DEFAULT_RETENTION_DAYS, DtcEpisodeService } from './dtc-episode.service';

/** Once a day: retention is counted in days, and a day's extra rows cost nothing. */
export const PRUNE_EVERY_MS = 24 * 3_600_000;
/** The first pass waits for the app to settle rather than adding to its start. */
export const FIRST_PRUNE_AFTER_MS = 5 * 60_000;

/**
 * Deletes fault codes cleared longer ago than retention (90 days unless
 * FAULT_HISTORY_RETENTION_DAYS says otherwise), vehicle DTCs and pump P-codes alike.
 *
 * `pruneHistory` existed from the first DTC cut, but nothing called it, so every cleared
 * code was kept for ever (found 16 Nov 2026) — and a pump's codes flicker at a threshold,
 * ten episodes in seven minutes in the POC run. Its own timer, not the DTC pull's: that
 * one is dormant unless the 1.0 pull is switched on, and a pump's codes need no 1.0.
 *
 * Off until FAULT_HISTORY_PRUNE_ENABLED=true. Its first pass deletes every code cleared
 * before the cutoff, all at once and for good, and nothing has been deleted before — so
 * switching it on is somebody's decision, not a side effect of a deploy. Safe on every
 * instance at once: the delete is one statement that deletes nothing the second time.
 * Active codes are never touched, however old.
 */
@Injectable()
export class FaultHistoryPruneScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FaultHistoryPruneScheduler.name);
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly episodes: DtcEpisodeService) {}

  onModuleInit(): void {
    if (`${process.env.FAULT_HISTORY_PRUNE_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('FAULT_HISTORY_PRUNE_ENABLED is not true; cleared fault codes are kept.');
      return;
    }
    this.first = setTimeout(() => void this.prune(), FIRST_PRUNE_AFTER_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.prune(), PRUNE_EVERY_MS);
    this.timer.unref?.();
    this.logger.log(`Cleared fault codes are kept ${retentionDays()} days.`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async prune(): Promise<number> {
    try {
      const deleted = await this.episodes.pruneHistory(retentionDays());
      if (deleted) this.logger.log(`Deleted ${deleted} fault code(s) cleared more than ${retentionDays()} days ago.`);
      return deleted;
    } catch (err) {
      // Never fatal: the next day's pass deletes the same rows.
      this.logger.warn(`Fault history not pruned this pass: ${(err as Error).message}`);
      return 0;
    }
  }
}

/** A number of days from the environment, or the default; never zero or less, which would delete the day's own codes. */
export function retentionDays(raw = process.env.FAULT_HISTORY_RETENTION_DAYS): number {
  const days = Number(raw);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
}
