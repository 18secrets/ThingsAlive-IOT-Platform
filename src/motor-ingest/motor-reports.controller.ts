import { BadRequestException, Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { parseDay } from './motor-reports';
import { MotorReportsService } from './motor-reports.service';

/**
 * A machine's motor-logger reports (Motor Monitor integration spec, 24 Nov 2026, "Web
 * application features"): data quality, daily running hours and energy, and a CSV of the
 * readings. `device.read`, as the loggers' recent data is: what your own kit recorded.
 */
@ApiTags('Motor loggers')
@Controller()
export class MotorReportsController {
  constructor(private readonly reports: MotorReportsService) {}

  @Get('equipment/:sourceSystem/:externalId/logger/data-quality')
  @Requires('device.read')
  @ApiOperation({ summary: "Per motor logger on the machine: gaps in seq, restarts (boot), lost and dropped records, uploads, over a window (default the last day, at most 31 days)" })
  quality(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.quality(scope, { sourceSystem, externalId }, parseDate(from, 'from'), parseDate(to, 'to'));
  }

  @Get('equipment/:sourceSystem/:externalId/logger/daily')
  @Requires('device.read')
  @ApiOperation({ summary: "Per motor logger on the machine, per day in the account's time zone: running hours, energy (kWh) and coverage (from/to as YYYY-MM-DD, default the last 7 days, at most 92)" })
  daily(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.daily(scope, { sourceSystem, externalId }, parseDay(from, 'from'), parseDay(to, 'to'));
  }

  @Get('equipment/:sourceSystem/:externalId/logger/readings.csv')
  @Requires('device.read')
  @ApiOperation({ summary: "The machine's motor logger readings, one per second, as CSV ordered by seq (one logger with device_id, else all; default the last day, at most 31 days)" })
  async csv(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('device_id') deviceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StreamableFile> {
    const { name, stream } = await this.reports.csv(scope, { sourceSystem, externalId }, deviceId || undefined, parseDate(from, 'from'), parseDate(to, 'to'));
    return new StreamableFile(stream, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}"` });
  }
}

/** Unreadable is refused, not dropped: an Invalid Date silently matches nothing. */
function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${field} is not a date I can read: "${raw}".`);
  return parsed;
}
