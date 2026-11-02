import { Module } from '@nestjs/common';
import { LegacyShiftMetricsModule } from '../legacy/legacy-shift-metrics.module';
import { ShiftFuelApiService } from './shift-fuel-api.service';
import { ShiftFuelController } from './shift-fuel.controller';
import { ShiftFuelScheduler } from './shift-fuel.scheduler';
import { ShiftFuelService } from './shift-fuel.service';

/**
 * Fuel per shift, forecast from the existing platform's shift totals (D50). Beside the
 * hourly TTM forecasts in `src/forecast`, not instead of them: those stay on the live
 * signals, and this answers the one question they could not — how much fuel a shift
 * will take.
 */
@Module({
  imports: [LegacyShiftMetricsModule],
  controllers: [ShiftFuelController],
  providers: [ShiftFuelService, ShiftFuelScheduler, ShiftFuelApiService],
  exports: [ShiftFuelService],
})
export class ShiftFuelModule {}
