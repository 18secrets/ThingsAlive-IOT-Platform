import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { AvailabilityService } from './services/availability.service';
import { GroupBy, UtilizationService } from './services/utilization.service';

const GROUPS: GroupBy[] = ['equipment', 'plant', 'date', 'shift'];

/**
 * How the fleet spent its time (task P4-05).
 *
 * Behind `utilization.read`, which every role inside the tenant holds. An operator's
 * view is narrowed by the machines assigned to them rather than by the capability —
 * the same rule as everywhere else, because "which machines" and "what may you do"
 * are different questions and answering one with the other is how a manager loses
 * sight of half their fleet.
 */
@ApiTags('Utilization')
@Controller('utilization')
export class UtilizationController {
  constructor(
    private readonly utilization: UtilizationService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('summary')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Productive, idle and off hours rolled up by machine, site, day or shift' })
  summary(
    @CurrentScope() scope: RequestScope,
    @Query('groupBy') groupBy = 'equipment',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plantId') plantId?: string,
  ) {
    if (!GROUPS.includes(groupBy as GroupBy)) {
      throw new BadRequestException(
        `groupBy must be one of ${GROUPS.join(', ')}.`,
      );
    }
    return this.utilization.summary(scope, {
      groupBy: groupBy as GroupBy,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      plantId,
    });
  }

  @Get('equipment/:sourceSystem/:externalId')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Shift by shift for one machine, newest first' })
  forEquipment(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.utilization.forEquipment(
      scope, { sourceSystem, externalId },
      { from: parseDate(from, 'from'), to: parseDate(to, 'to') },
    );
  }

  @Get('availability')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Availability across the fleet: uptime against scheduled shift hours. Not OEE' })
  fleetAvailability(
    @CurrentScope() scope: RequestScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.availability.forFleet(scope, parsePeriod(from, to));
  }

  @Get('availability/:sourceSystem/:externalId')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Availability for one machine: uptime against scheduled shift hours. Not OEE' })
  equipmentAvailability(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.availability.forEquipment(
      scope, { sourceSystem, externalId }, parsePeriod(from, to),
    );
  }
}

/**
 * Availability is a ratio over a period, so the period is required.
 *
 * Utilization's summary can default to "everything", because summed hours over
 * everything still mean something. Availability over an unstated period would be
 * scheduled hours since the first shift was defined, which nobody asked for.
 */
function parsePeriod(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  const start = parseDate(from, 'from');
  const end = parseDate(to, 'to');
  if (!start || !end) throw new BadRequestException('from and to are both required.');
  if (end <= start) throw new BadRequestException('to must be after from.');
  return { from: start, to: end };
}

/**
 * An unparseable date is refused rather than dropped.
 *
 * `new Date('last tuesday')` is an Invalid Date, and an Invalid Date in a WHERE
 * clause silently matches nothing — so a typo in a range would return an empty
 * report that looks exactly like a fleet that did no work.
 */
function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} is not a date I can read: "${raw}".`);
  }
  return parsed;
}
