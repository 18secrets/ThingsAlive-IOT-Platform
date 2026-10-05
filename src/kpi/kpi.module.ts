import { Module } from '@nestjs/common';
import { SignalBindingModule } from '../signal-binding/signal-binding.module';
import { KpiController } from './kpi.controller';
import { KpiEvaluatorService } from './services/kpi-evaluator.service';

/**
 * The runtime evaluator (task QCE2). `EquipmentProfile`, `ClientEquipmentClass`,
 * `ClientFormula`, `DeviceProjection`, `WorkOrder` and `TelemetryReading` are
 * read directly off the shared `DataSource` inside `KpiEvaluatorService` rather
 * than through `TypeOrmModule.forFeature` here — the same pattern
 * `SignalBindingModule` already uses, for the same reason: they are not this
 * module's tables to own.
 */
@Module({
  imports: [SignalBindingModule],
  controllers: [KpiController],
  providers: [KpiEvaluatorService],
  exports: [KpiEvaluatorService],
})
export class KpiModule {}
