import { BadRequestException, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ShiftFuelApiService } from './shift-fuel-api.service';

const MAX_DAYS = 90;

const SHAPE = 'Shifts are the existing platform\'s: 1 is 08:00-20:00 Asia/Kolkata on sdate, 2 is 20:00 on sdate to 08:00 '
  + 'the next day. predictedL is issued before the shift ends and never changed once it has started; inputsThrough is the '
  + 'newest day it used (null: no history, forecast 0). fuelL and workHrs are the existing platform\'s totals, null until '
  + 'it has totalled the shift. Method ewma-0.5-28d (D50).';

/**
 * Fuel per shift, forecast and actual (D50). `prediction.read`, the gate the hourly
 * forecasts use: this is a forecast too, and every role inside the account reads them. A
 * machine outside the caller's scope is a 404, as on every other equipment route.
 */
@ApiTags('Forecasts')
@Controller()
export class ShiftFuelController {
  constructor(private readonly fuel: ShiftFuelApiService) {}

  @Get('equipment/:sourceSystem/:externalId/shift-fuel-forecast')
  @Requires('prediction.read')
  @ApiQuery({ name: 'days', required: false, description: `Days back from today, 1-${MAX_DAYS}; default 14` })
  @ApiOperation({ summary: 'This machine\'s recent shifts: forecast litres, and the actual litres and hours where synced', description: SHAPE })
  machine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number,
  ) {
    if (days < 1 || days > MAX_DAYS) throw new BadRequestException(`days must be between 1 and ${MAX_DAYS}.`);
    return this.fuel.machine(scope, { sourceSystem, externalId }, days);
  }

  @Get('shift-fuel-forecasts')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Each machine\'s newest two shift fuel forecasts, and the fleet total per shift', description: SHAPE })
  fleet(@CurrentScope() scope: RequestScope) {
    return this.fuel.fleet(scope);
  }
}
