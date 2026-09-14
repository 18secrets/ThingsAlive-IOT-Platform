import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
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
  constructor(private readonly utilization: UtilizationService) {}

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
