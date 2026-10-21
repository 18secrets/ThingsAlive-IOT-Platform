import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** How far ahead the daily pass keeps partitions built. */
export const MAINTENANCE_HORIZON_MONTHS = 3;

/**
 * Keeps `telemetry_reading` ahead of the data it is about to receive (task QPART1).
 *
 * The migration builds partitions from the earliest existing row through 12 months
 * ahead — a large buffer, but a one-time one. This is what keeps that buffer from
 * running out on a platform nobody redeploys for a year: every day it re-asserts that
 * the next few months exist, so a deploy is never the thing standing between an
 * insert and a partition to land in.
 *
 * `ensure_telemetry_partition` is idempotent, so this is not a claim on work the way
 * `ShiftRunner`'s pass lock is — two instances calling it for the same month at the
 * same moment cost one duplicate-table exception inside the function, not a
 * duplicated partition. Nothing here needs an advisory lock of its own.
 */
@Injectable()
export class TelemetryPartitionMaintenance {
  private readonly logger = new Logger(TelemetryPartitionMaintenance.name);

  constructor(private readonly ds: DataSource) {}

  async ensureUpcomingPartitions(now = new Date()): Promise<string[]> {
    const created: string[] = [];
    for (let offset = 0; offset < MAINTENANCE_HORIZON_MONTHS; offset += 1) {
      // A literal 'YYYY-MM-01' string, not a Date object: a Date bound to a `date`
      // parameter is interpreted in the session's timezone, so midnight UTC on the
      // 1st silently becomes the last day of the *previous* month wherever the
      // server sits behind UTC — this ran every day, so it would have built the
      // wrong month every day.
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      const month = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const [row] = await this.ds.query(`SELECT ensure_telemetry_partition($1::date) AS name`, [month]);
      created.push(row.name);
    }
    return created;
  }

  async run(now = new Date()): Promise<void> {
    try {
      const partitions = await this.ensureUpcomingPartitions(now);
      this.logger.debug(`Partitions confirmed through ${partitions[partitions.length - 1]}.`);
    } catch (error) {
      // A day this fails is a day the migration's 12-month buffer absorbs. Logged
      // rather than rethrown, like every other scheduled pass in this codebase — a
      // timer whose callback throws takes nothing down and reports nothing.
      this.logger.error(`Could not confirm upcoming telemetry partitions: ${(error as Error).message}`);
    }
  }
}
