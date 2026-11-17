import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { WorkOrderEvent } from './entities/work-order-event.entity';
import { WorkOrder, WorkOrderCounter } from './entities/work-order.entity';
import { PredictionWorkRaiser } from './services/prediction-work-raiser.service';
import { WorkOrderService } from './services/work-order.service';
import { WorkOrderController } from './work.controller';
import { WORK_RAISER } from '../prediction/work-raiser';

@Module({
  // IdentityModule for the scope resolver. WorkOrderService takes it @Optional() so its
  // specs can build the service bare, which also meant a module that never supplied it
  // started cleanly — and "can this person open the machine" quietly passed for anyone,
  // so a job could go to somebody who would never see it (testing sheet TC_148).
  imports: [TypeOrmModule.forFeature([WorkOrder, WorkOrderCounter, WorkOrderEvent]), IdentityModule],
  controllers: [WorkOrderController],
  providers: [
    WorkOrderService,
    PredictionWorkRaiser,
    { provide: WORK_RAISER, useExisting: PredictionWorkRaiser },
  ],
  exports: [WorkOrderService, WORK_RAISER],
})
export class WorkModule {}
