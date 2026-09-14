import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrderEvent } from './entities/work-order-event.entity';
import { WorkOrder, WorkOrderCounter } from './entities/work-order.entity';
import { PredictionWorkRaiser } from './services/prediction-work-raiser.service';
import { WorkOrderService } from './services/work-order.service';
import { WorkOrderController } from './work.controller';
import { WORK_RAISER } from '../prediction/work-raiser';

@Module({
  imports: [TypeOrmModule.forFeature([WorkOrder, WorkOrderCounter, WorkOrderEvent])],
  controllers: [WorkOrderController],
  providers: [
    WorkOrderService,
    PredictionWorkRaiser,
    { provide: WORK_RAISER, useExisting: PredictionWorkRaiser },
  ],
  exports: [WorkOrderService, WORK_RAISER],
})
export class WorkModule {}
