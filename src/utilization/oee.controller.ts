import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { OEE_WINDOWS, OeeService, OeeWindow } from './services/oee.service';

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
  @ApiOperation({ summary: 'OEE for one machine over a day, week or month: availability × performance × quality' })
  forEquipment(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('window') window?: string,
    @Query('at') at?: string,
  ) {
    return this.oee.forEquipment(scope, { sourceSystem, externalId }, parseWindow(window), parseDate(at, 'at') ?? new Date());
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
  @ApiOperation({ summary: 'OEE for a site: summed over the machines whose own OEE is ready' })
  forSite(
    @CurrentScope() scope: RequestScope,
    @Param('plantId') plantId: string,
    @Query('window') window?: string,
    @Query('at') at?: string,
  ) {
    return this.oee.forSite(scope, plantId, parseWindow(window), parseDate(at, 'at') ?? new Date());
  }
}

function parseWindow(raw: string | undefined): OeeWindow {
  const window = (raw ?? 'day') as OeeWindow;
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
