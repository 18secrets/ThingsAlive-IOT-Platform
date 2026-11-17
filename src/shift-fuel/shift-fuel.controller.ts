import { BadRequestException, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { AccuracyQueryError, MAX_RANGE_DAYS, parseAccuracyQuery } from './shift-fuel-accuracy';
import { ShiftFuelAccuracy, ShiftFuelAccuracyApiService } from './shift-fuel-accuracy-api.service';
import { FleetShiftFuel, MachineShiftFuel, ShiftFuelApiService } from './shift-fuel-api.service';
import { FleetShiftFuelNowcast, ShiftFuelNowcastApiService, ShiftFuelNowcastView } from './shift-fuel-nowcast-api.service';

const MAX_DAYS = 90;

const NOWCAST = ' nowcast (nowcasts on the fleet route) is the newest in-shift snapshot of the shift under way (D52): '
  + 'soFarL litres burned since it started, read off the fuel counter, plus baseL (its forecast) times the share of the '
  + 'twelve hours left, as predictedL; asOf is the quarter hour it describes and counterAt the newest reading it used. '
  + 'Null, or absent from the list, when there is no snapshot: no shift has a reading yet, or the nowcast is not running.';

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
  constructor(
    private readonly fuel: ShiftFuelApiService,
    private readonly nowcast: ShiftFuelNowcastApiService,
    private readonly accuracyApi: ShiftFuelAccuracyApiService,
  ) {}

  @Get('equipment/:sourceSystem/:externalId/shift-fuel-forecast')
  @Requires('prediction.read')
  @ApiQuery({ name: 'days', required: false, description: `Days back from today, 1-${MAX_DAYS}; default 14` })
  @ApiOperation({ summary: 'This machine\'s recent shifts: forecast litres, and the actual litres and hours where synced', description: SHAPE + NOWCAST })
  async machine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number,
  ): Promise<MachineShiftFuel & { nowcast: ShiftFuelNowcastView | null }> {
    if (days < 1 || days > MAX_DAYS) throw new BadRequestException(`days must be between 1 and ${MAX_DAYS}.`);
    const ref = { sourceSystem, externalId };
    const at = new Date();
    // The forecast first: it is what answers 404 for a machine that is absent or out of scope.
    return this.nowcast.besideMachine(scope, ref, await this.fuel.machine(scope, ref, days, at), at);
  }

  @Get('shift-fuel-forecasts')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Each machine\'s newest two shift fuel forecasts, and the fleet total per shift', description: SHAPE + NOWCAST })
  async fleet(@CurrentScope() scope: RequestScope): Promise<FleetShiftFuel & { nowcasts: FleetShiftFuelNowcast[] }> {
    const at = new Date();
    return this.nowcast.besideFleet(scope, await this.fuel.fleet(scope, at), at);
  }

  @Get('shift-fuel-accuracy')
  @Requires('prediction.read')
  @ApiQuery({ name: 'from', required: false, description: 'First sdate, YYYY-MM-DD; default today in Asia/Kolkata' })
  @ApiQuery({ name: 'to', required: false, description: `Last sdate, inclusive; default today. At most ${MAX_RANGE_DAYS} days from from` })
  @ApiQuery({ name: 'level', required: false, enum: ['day', 'shift', 'range'], description: 'What one miss is counted over; default day' })
  @ApiOperation({
    summary: 'How accurate the shift fuel forecast and the in-shift nowcast were, per machine and for the fleet',
    description: 'Completed shifts only, in range by sdate. accuracy = max(0, 100 - round(100 x miss / actual)), null when '
      + 'nothing burned. A shift with no forecast (or no snapshot by a checkpoint) is left out of that score and counted '
      + 'in shiftsWithoutForecast (shiftsWithoutCheckpoint). checkpoints are the nowcast\'s accuracy 2, 4 and 6 hours in. '
      + 'fleet covers only machines that burned fuel in the range. latestDataDate is the newest day with a completed, '
      + 'totalled shift (D53).',
  })
  async accuracy(
    @CurrentScope() scope: RequestScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('level') level?: string,
  ): Promise<ShiftFuelAccuracy> {
    const at = new Date();
    let query;
    try {
      query = parseAccuracyQuery({ from, to, level }, at);
    } catch (err) {
      if (err instanceof AccuracyQueryError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.accuracyApi.accuracy(scope, query, at);
  }
}
