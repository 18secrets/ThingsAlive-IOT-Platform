import { Module } from '@nestjs/common';
import { LegacyShiftMetricsModule } from '../legacy/legacy-shift-metrics.module';
import { ShiftFuelAccuracyApiService } from './shift-fuel-accuracy-api.service';
import { ShiftFuelApiService } from './shift-fuel-api.service';
import { ShiftFuelNowcastApiService } from './shift-fuel-nowcast-api.service';
import { ShiftFuelNowcastScheduler } from './shift-fuel-nowcast.scheduler';
import { ShiftFuelNowcastService } from './shift-fuel-nowcast.service';
import { ShiftFuelController } from './shift-fuel.controller';
import { ShiftFuelScheduler } from './shift-fuel.scheduler';
import { ShiftFuelService } from './shift-fuel.service';

/**
 * Fuel per shift, forecast from the existing platform's shift totals (D50). Beside the
 * hourly TTM forecasts in `src/forecast`, not instead of them: those stay on the live
 * signals, and this answers the one question they could not — how much fuel a shift
 * will take. While a shift runs, the nowcast (D52) re-forecasts it from the litres
 * already burned. How close both came is scored from the same tables (D53).
 */
@Module({
  imports: [LegacyShiftMetricsModule],
  controllers: [ShiftFuelController],
  providers: [
    ShiftFuelService, ShiftFuelScheduler, ShiftFuelApiService,
    ShiftFuelNowcastService, ShiftFuelNowcastScheduler, ShiftFuelNowcastApiService,
    ShiftFuelAccuracyApiService,
  ],
  exports: [ShiftFuelService],
})
export class ShiftFuelModule {}
