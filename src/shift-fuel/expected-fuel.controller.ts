import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ExpectedFuelApiService, MachineExpectedFuel } from './expected-fuel-api.service';
import { AccuracyQueryError, parseAccuracyQuery } from './shift-fuel-accuracy';
import { ShiftFuelCoverage, ShiftFuelCoverageService } from './shift-fuel-coverage.service';

/**
 * Expected litres per shift before a machine has any history (fuel test report TC-FP-07,
 * TC-FP-09, TC-FP-11). `prediction.read`, the gate D50's forecast routes use: this is the
 * same question answered from physics instead of from the machine's own past.
 */
@ApiTags('Forecasts')
@Controller()
export class ExpectedFuelController {
  constructor(
    private readonly expected: ExpectedFuelApiService,
    private readonly coverageService: ShiftFuelCoverageService,
  ) {}

  @Get('equipment/:sourceSystem/:externalId/expected-fuel')
  @Requires('prediction.read')
  @ApiOperation({
    summary: 'Litres this machine\'s current and next shift should take, from its class figures and schedule alone',
    description: 'No history needed. working rate = rated_power_kw x working_load_pct/100 x bsfc_g_per_kwh / 835 g/L, '
      + 'or the class nominal L/h when no BSFC is recorded; predictedL = working rate x shift hours x working_share + '
      + 'idle_fuel_per_hour x the rest. Every input is listed with its source. A missing figure blocks the answer: '
      + 'predictedL is null and blockedBy names each one (no_class, no_shift_schedule, working_rate_not_set, '
      + 'nominal_unit_not_litres, working_share_not_set, idle_fuel_per_hour_not_set). Nothing is assumed.',
  })
  machine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ): Promise<MachineExpectedFuel> {
    return this.expected.machine(scope, { sourceSystem, externalId });
  }

  @Get('shift-fuel-coverage')
  @Requires('prediction.read')
  @ApiQuery({ name: 'from', required: false, description: 'First sdate, YYYY-MM-DD; default today in Asia/Kolkata' })
  @ApiQuery({ name: 'to', required: false, description: 'Last sdate, inclusive; default today' })
  @ApiOperation({
    summary: 'Which fuel-burning machines the shift fuel forecast covers, and why the rest are not',
    description: 'A machine is fuel-burning when a fuel_consumption or fuel_level signal was bound to it in the range; '
      + 'covered when the existing platform sent at least one shift total for it in the range. notCovered lists the rest: '
      + 'mirrored_from_1_0 (keyed by 1.0\'s row id, never matched to an equipment number) or no_shift_totals.',
  })
  coverage(
    @CurrentScope() scope: RequestScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ShiftFuelCoverage> {
    const at = new Date();
    let query;
    try {
      query = parseAccuracyQuery({ from, to }, at);
    } catch (err) {
      if (err instanceof AccuracyQueryError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.coverageService.coverage(scope, query, at);
  }
}
