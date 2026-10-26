import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ForecastApiService } from './forecast-api.service';

const READINESS = 'Each forecast is ready (24 hourly points with their interval, the model and run that made them, '
  + 'and the newest actual judged against the residual band: normal, anomalous or baseline_not_established) or says '
  + 'why not: not_configured (forecast_not_declared, unbound), not_available (no_forecast_model, '
  + 'baseline_not_established) or blocked (stale, no_readings). A forecast is never shown without its interval (D26).';

/**
 * Granite TTM forecasts over HTTP. `prediction.read`, the gate the recommendation
 * evidence uses: a forecast is a prediction, and every role inside the tenant reads them.
 * A machine outside the caller's scope is a 404, the same answer as any other equipment route.
 */
@ApiTags('Forecasts')
@Controller()
export class ForecastApiController {
  constructor(private readonly forecasts: ForecastApiService) {}

  @Get('equipment/:sourceSystem/:externalId/forecasts')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Every signal this machine\'s class declares a forecast for, each ready or saying why not', description: READINESS })
  machine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.forecasts.machine(scope, { sourceSystem, externalId });
  }

  @Get('equipment/:sourceSystem/:externalId/forecasts/:signal')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One signal\'s forecast; a signal the class does not declare is not_configured', description: READINESS })
  signal(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Param('signal') signal: string,
  ) {
    return this.forecasts.signal(scope, { sourceSystem, externalId }, signal);
  }
}
