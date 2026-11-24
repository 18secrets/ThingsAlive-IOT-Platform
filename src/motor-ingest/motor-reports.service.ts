import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { mappedDevicesSql } from '../onboarding/mapped-devices';
import { withTenantSession } from '../scope/tenant-session';
import {
  DayTotals, LoggerQuality, MAX_DAILY_DAYS, MAX_EXPORT_WINDOW_DAYS, MAX_QUALITY_WINDOW_DAYS,
  dailyTotals, loggerQuality, loggersOf, readingsCsv, window,
} from './motor-reports';

export interface EquipmentRef { sourceSystem: string; externalId: string }

export interface LoggerQualityReport { from: string; to: string; loggers: LoggerQuality[] }
export interface LoggerDailyReport { from: string; to: string; timeZone: string; loggers: { deviceId: string; days: DayTotals[] }[] }

/**
 * The motor loggers' reports for one machine (motor-reports.ts): the caller sees them
 * for a machine they can see, as the Live view and the events do, and only for the
 * loggers mapped to it. A machine with no logger answers with none, not a 404: it is a
 * machine, it just has nothing of this kind to report.
 */
@Injectable()
export class MotorReportsService {
  constructor(private readonly ds: DataSource) {}

  async quality(scope: RequestScope, ref: EquipmentRef, from: Date | undefined, to: Date | undefined, now = new Date()): Promise<LoggerQualityReport> {
    const w = window(from, to, now, MAX_QUALITY_WINDOW_DAYS);
    return this.onMachine(scope, ref, async (m) => {
      const loggers = await loggersOf(m, mappedDevicesSql('$1', '$3', true), scope.tenantId, ref.externalId, w.to);
      const out: LoggerQuality[] = [];
      for (const deviceId of loggers) out.push(await loggerQuality(m, deviceId, w));
      return { from: w.from.toISOString(), to: w.to.toISOString(), loggers: out };
    });
  }

  /** Days are calendar days in the account's time zone, `to` included; the last seven by default. */
  async daily(scope: RequestScope, ref: EquipmentRef, fromDay: string | undefined, toDay: string | undefined, now = new Date()): Promise<LoggerDailyReport> {
    return this.onMachine(scope, ref, async (m) => {
      const [tenant] = await m.query(`SELECT coalesce("time_zone", 'Asia/Kolkata') AS "tz" FROM "tenant" WHERE "tenant_id" = $1`, [scope.tenantId]);
      const timeZone: string = tenant?.tz ?? 'Asia/Kolkata';
      const [{ today }] = await m.query(`SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS "today"`, [now, timeZone]);
      const to = toDay ?? today;
      const from = fromDay ?? isoDay(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000);
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      if (span < 1) throw new BadRequestException('from must not be after to.');
      if (span > MAX_DAILY_DAYS) throw new BadRequestException(`At most ${MAX_DAILY_DAYS} days at a time.`);
      // Ever mapped by the end of the last day, so a logger that moved on keeps its days here.
      const [{ end }] = await m.query(`SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS "end"`, [to, timeZone]);
      const loggers = await loggersOf(m, mappedDevicesSql('$1', '$3', true), scope.tenantId, ref.externalId, new Date(end));
      const out: { deviceId: string; days: DayTotals[] }[] = [];
      for (const deviceId of loggers) out.push({ deviceId, days: await dailyTotals(m, deviceId, from, to, timeZone) });
      return { from, to, timeZone, loggers: out };
    });
  }

  /**
   * The machine's logger readings as CSV, one logger or all of them. Access and the
   * logger list are settled before the first byte; the rows then stream a page at a time
   * from the receiver's table, which carries no tenant and needs no tenant session.
   */
  async csv(scope: RequestScope, ref: EquipmentRef, deviceId: string | undefined, from: Date | undefined, to: Date | undefined, now = new Date()) {
    const w = window(from, to, now, MAX_EXPORT_WINDOW_DAYS);
    const loggers = await this.onMachine(scope, ref, (m) =>
      loggersOf(m, mappedDevicesSql('$1', '$3', true), scope.tenantId, ref.externalId, w.to));
    const chosen = deviceId ? loggers.filter((d) => d === deviceId) : loggers;
    if (!chosen.length) {
      throw new NotFoundException(deviceId ? 'No such motor logger on this machine.' : 'This machine has no motor logger.');
    }
    const name = `${chosen.length === 1 ? chosen[0] : ref.externalId}_${isoDay(w.from.getTime())}_${isoDay(w.to.getTime())}.csv`
      .replace(/[^A-Za-z0-9._-]/g, '_');
    const stream = Readable.from(readingsCsv((sql, params) => this.ds.query(sql, params), chosen, w));
    return { name, stream };
  }

  private async onMachine<R>(scope: RequestScope, ref: EquipmentRef, fn: (m: EntityManager) => Promise<R>): Promise<R> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      });
      if (!profile) throw new NotFoundException('No such equipment in this account.');
      return fn(m);
    });
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
