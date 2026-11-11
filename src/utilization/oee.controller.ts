import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { OEE_WINDOWS, OeePeriod, OeeService, OeeWindow } from './services/oee.service';

/**
 * OEE as a KPI (task QOEE1), behind `utilization.read` like Availability, which it
 * extends. One producer per number: this composes no page.
 */
@ApiTags('Utilization')
@Controller()
export class OeeController {
  constructor(private readonly oee: OeeService) {}

  @Get('equipment/:sourceSystem/:externalId/oee')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'OEE for one machine over a day, week or month, or a from/to range of up to 92 days: availability × performance × quality' })
  forEquipment(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('window') window?: string,
    @Query('at') at?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.oee.forEquipment(scope, { sourceSystem, externalId }, parsePeriod(window, from, to), parseDate(at, 'at') ?? new Date());
  }

  @Get('equipment/:sourceSystem/:externalId/breakdowns')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Breakdown events (idle with fuel inside a shift past the threshold) for one machine' })
  breakdowns(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = parseDate(from, 'from');
    const end = parseDate(to, 'to');
    if (!start || !end) throw new BadRequestException('from and to are both required.');
    if (end <= start) throw new BadRequestException('to must be after from.');
    return this.oee.breakdowns(scope, { sourceSystem, externalId }, start, end);
  }

  @Get('plants/:plantId/oee')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'OEE for a site over a window or a from/to range: summed over the machines whose own OEE is ready' })
  forSite(
    @CurrentScope() scope: RequestScope,
    @Param('plantId') plantId: string,
    @Query('window') window?: string,
    @Query('at') at?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.oee.forSite(scope, plantId, parsePeriod(window, from, to), parseDate(at, 'at') ?? new Date());
  }
}

/** from/to is a range (P3-D4) and wins over `window`; both are needed, one alone is refused
 * rather than guessed at. Without them, the named window as before. */
function parsePeriod(window: string | undefined, from: string | undefined, to: string | undefined): OeePeriod {
  const start = parseDate(from, 'from');
  const end = parseDate(to, 'to');
  if (start || end) {
    if (!start || !end) throw new BadRequestException('A range needs both from and to.');
    return { from: start, to: end };
  }
  return parseWindow(window);
}

function parseWindow(raw: string | undefined): OeeWindow {
  const window = (raw ?? 'day') as OeeWindow;
  // 'range' is what a from/to answers with, not something to ask for by name.
  if (window === 'range') throw new BadRequestException('Ask for a range with from and to.');
  if (!OEE_WINDOWS.includes(window)) throw new BadRequestException(`window must be one of ${OEE_WINDOWS.join(', ')}.`);
  return window;
}

/** Unreadable is refused, not dropped: an Invalid Date silently matches nothing. */
function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${field} is not a date I can read: "${raw}".`);
  return parsed;
}
